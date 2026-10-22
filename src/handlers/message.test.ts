import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ProcessEvent, ProcessEventHandler } from "../processes.js";
import { registerMessageHandlers, beginTurnTyping } from "./message.js";
import { topicRuntime, removeTopicRuntime } from "../topic-runtime.js";

const CHAT = -100;

/** Minimal fake ProcessManager exposing only what the event handler's error
 *  branch touches. `hasCancelPending` is the load-bearing stub: it decides
 *  whether the handler skips the StopFailure auto-resend or falls through to
 *  it. */
function fakePm(cancelPending: boolean, running: boolean) {
  let captured: ProcessEventHandler | undefined;
  return {
    setEventHandler: (handler: ProcessEventHandler) => { captured = handler; },
    getHandler: () => captured!,
    hasCancelPending: vi.fn(() => cancelPending),
    isDoneNotify: vi.fn(() => false),
    isRunning: vi.fn(() => running),
    getSessionId: vi.fn(() => undefined),
    getPid: vi.fn(() => undefined),
    kill: vi.fn(),
    getSpawnedAt: vi.fn(() => undefined),
  };
}

function fakeBot() {
  return {
    api: { sendMessage: vi.fn(async () => ({})), sendChatAction: vi.fn(async () => ({})) },
    on: vi.fn(),
    hears: vi.fn(),
  };
}

describe("registerMessageHandlers — StopFailure cancellation exemption", () => {
  let dir: string;
  let topicId = 1000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-message-"));
    topicId += 1; // fresh composite key per test — module-level maps persist across tests
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
    removeTopicRuntime(CHAT, topicId);
  });

  it("error: a pending cancellation (process not running) skips auto-resend and reports a neutral acknowledgment", async () => {
    const pm = fakePm(true, false);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);

    const event: ProcessEvent = { chatId: CHAT, topicId, event: "error", text: "server_error" };
    await pm.getHandler()(event);

    expect(pm.hasCancelPending).toHaveBeenCalledWith(CHAT, topicId);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, "✅ Interrupt acknowledged.", { message_thread_id: topicId });
    // isRunning was checked (to decide `recovered`), but kill/resend never ran.
    expect(pm.kill).not.toHaveBeenCalled();
  });

  it("error: a pending cancellation on a still-running process reports the session-reset variant, not a resend", async () => {
    const pm = fakePm(true, true);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);

    const event: ProcessEvent = { chatId: CHAT, topicId, event: "error", text: "server_error" };
    await pm.getHandler()(event);

    expect(pm.kill).toHaveBeenCalledWith(CHAT, topicId);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      CHAT,
      "♻️ Session reset (a cancellation was in progress) — send a new message to continue.",
      { message_thread_id: topicId },
    );
  });

  it("error: a normal (non-cancelled) failure still runs the ordinary error path, not the cancellation acknowledgment", async () => {
    const pm = fakePm(false, false);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);

    const event: ProcessEvent = { chatId: CHAT, topicId, event: "error", text: "server_error" };
    await pm.getHandler()(event);

    expect(bot.api.sendMessage).toHaveBeenCalled();
    const calls = bot.api.sendMessage.mock.calls;
    expect(calls.some((c: any[]) => c[1] === "✅ Interrupt acknowledged.")).toBe(false);
    expect(calls.some((c: any[]) => typeof c[1] === "string" && c[1].includes("cancellation was in progress"))).toBe(false);
  });

  it("killed disposes the topic runtime — every timer the topic armed is cleared", async () => {
    vi.useFakeTimers();
    try {
      const pm = fakePm(false, true);
      const bot = fakeBot();
      registerMessageHandlers(bot as any, pm as any, dir);
      const handler = pm.getHandler();

      // "reply" is an activity event → keepTyping arms the typing interval slot.
      await handler({ chatId: CHAT, topicId, event: "reply", messageId: 1, text: "hi" });
      expect(topicRuntime(CHAT, topicId).timers.size).toBeGreaterThan(0);

      await handler({ chatId: CHAT, topicId, event: "killed" });
      expect(topicRuntime(CHAT, topicId).timers.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registerMessageHandlers — typing keep-alive", () => {
  let dir: string;
  let topicId = 7000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-typing-"));
    topicId += 1;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true });
    removeTopicRuntime(CHAT, topicId);
  });

  it("activity while typing runs sends an immediate chat action (throttled) instead of waiting for the next 4s tick", async () => {
    const pm = fakePm(false, true);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);
    const handler = pm.getHandler();

    // First activity: indicator was fully stopped → starts (one immediate action).
    await handler({ chatId: CHAT, topicId, event: "tool_use" });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

    // 2s later (before the 4s interval tick): a reply lands — Telegram just
    // cleared the typing status, so the keep-alive must re-send NOW.
    await vi.advanceTimersByTimeAsync(2000);
    await handler({ chatId: CHAT, topicId, event: "reply", messageId: 1, text: "hi" });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    // Immediately after, another activity event: inside the nudge throttle — no extra send.
    await handler({ chatId: CHAT, topicId, event: "tool_use" });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

    // But another REPLY inside the throttle still sends: a reply is a confirmed
    // bot message, so the status was definitely just cleared.
    await handler({ chatId: CHAT, topicId, event: "reply", messageId: 2, text: "more" });
    expect(bot.api.sendChatAction).toHaveBeenCalledTimes(3);
  });

  it("typing resurrected by post-turn activity auto-stops after the idle cap (never pinned on forever)", async () => {
    const pm = fakePm(false, true);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);
    const handler = pm.getHandler();
    const rt = topicRuntime(CHAT, topicId);

    // A stray tool_use with no delivery behind it — e.g. a lingering parallel
    // subagent after the final done — resurrects the indicator…
    await handler({ chatId: CHAT, topicId, event: "tool_use" });
    expect(rt.timers.has("typing")).toBe(true);

    // …but with no further activity it must die at the idle cap, not run until
    // the next turn happens to stop it.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    expect(rt.timers.has("typing")).toBe(false);
    const sends = bot.api.sendChatAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.api.sendChatAction.mock.calls.length).toBe(sends);
  });

  it("activity during the post-done settle window inherits the idle cap — the trailing-subagent case", async () => {
    const pm = fakePm(false, true);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);
    const handler = pm.getHandler();
    const rt = topicRuntime(CHAT, topicId);

    // A real delivery starts typing in normal (uncapped) mode.
    beginTurnTyping(bot as any, rt);
    await handler({ chatId: CHAT, topicId, event: "reply", messageId: 1, text: "answer" });
    await handler({ chatId: CHAT, topicId, event: "done" });

    // 1s into the 2.5s settle window — exactly where a lingering parallel
    // subagent's tool_use lands. It must NOT strip the pending stop and leave
    // the interval uncapped forever.
    await vi.advanceTimersByTimeAsync(1000);
    await handler({ chatId: CHAT, topicId, event: "tool_use" });
    expect(rt.timers.has("typing")).toBe(true); // still alive right now (capped)

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    expect(rt.timers.has("typing")).toBe(false);
  });
});

describe("registerMessageHandlers — reply counters reset on kill", () => {
  let dir: string;
  let topicId = 5000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-replycount-"));
    topicId += 1;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true });
  });

  it("a mid-turn kill clears both counters, so the next turn takes the /forward path", async () => {
    const pm = fakePm(false, true);
    (pm as any).isDoneNotify = vi.fn(() => true);
    const bot = fakeBot();
    registerMessageHandlers(bot as any, pm as any, dir);
    const handler = pm.getHandler();
    const rt = topicRuntime(CHAT, topicId);

    // Mid-turn: a reply landed (the daemon bumps the SAME shared runtime's
    // counter via topicRuntime(...).replyCount += 1 — simulated directly here
    // since the daemon's callback server isn't under test).
    rt.replyCount += 1;
    await handler({ chatId: CHAT, topicId, event: "reply", messageId: 7, text: "partial" });
    // …then the process is killed (StopFailure recovery / /stop / Force Stop).
    await handler({ chatId: CHAT, topicId, event: "killed" });

    // Daemon-side counter is zero again: the respawned session's first done
    // with no reply-tool call satisfies the /forward gate (replyCount === 0).
    expect(rt.replyCount).toBe(0);

    // Handler-side lastReplyMsg is gone too: a later done must not treat the
    // stale pre-kill reply as this turn's output (no done-notify scheduled).
    await handler({ chatId: CHAT, topicId, event: "done" });
    await vi.advanceTimersByTimeAsync(4000);
    const texts = bot.api.sendMessage.mock.calls.map((c: any[]) => c[1]);
    expect(texts.some((t: string) => typeof t === "string" && t.includes("Waiting for new message"))).toBe(false);
  });
});
