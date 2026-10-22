import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sendToChannel, registerMessageHandlers } from "./message.js";
import { topicRuntime, removeTopicRuntime } from "../topic-runtime.js";
import { saveProjects, clearConfigCache } from "../config.js";
import type { ProcessEvent, ProcessEventHandler } from "../processes.js";

// sendToChannel persists activity via session-state, which is module-level
// state pinned to whatever loadSessionState(dir) the real daemon called at
// boot. This test never calls loadSessionState, so the real functions would
// silently read/write the REAL ~/.teleclaude/sessions.json. Mock the stateful
// pieces and keep the pure one (spawnSettingsFor) real — same pattern as
// message.delivery.test.ts / scheduler.test.ts.
vi.mock("../session-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-state.js")>();
  return {
    ...actual,
    getTopicSession: vi.fn(() => undefined),
    updateTopicSession: vi.fn(),
  };
});

const CHAT = -200;
let TOPIC = 5000;

type ChannelStatus = "pending" | "registered" | "blocked";

/**
 * Stateful fake ProcessManager: spawn() flips `running` on (mirroring the
 * real ProcessManager), kill() records which generation it was asked to kill
 * and flips `running` off. Extends the fake-pm seam already used by
 * message.test.ts / message.delivery.test.ts with spawn-token bookkeeping,
 * which is what lets these tests assert generation-guarded kills
 * (killIfSameGeneration in message.ts) instead of just "kill was called".
 */
function fakePm(init: { running?: boolean; status?: ChannelStatus; spawnStartsProcess?: boolean; cancelPending?: boolean } = {}) {
  const state = {
    running: init.running ?? false,
    status: (init.status ?? "registered") as ChannelStatus,
    token: "gen-1" as string | undefined,
    killedTokens: [] as (string | undefined)[],
  };
  let handler: ProcessEventHandler | undefined;
  return {
    state,
    isRunning: vi.fn(() => state.running),
    getSpawnToken: vi.fn(() => state.token),
    getChannelStatus: vi.fn(() => state.status),
    getPort: vi.fn(() => 8899),
    getLastToolUse: vi.fn(() => undefined),
    getCurrentTurnToken: vi.fn(() => undefined),
    getSessionId: vi.fn(() => undefined),
    hasCancelPending: vi.fn(() => init.cancelPending ?? false),
    isDoneNotify: vi.fn(() => false),
    getSpawnedAt: vi.fn(() => undefined),
    beginTurn: vi.fn(() => ({ seq: 1, nonce: "n" })),
    setEventHandler: (h: ProcessEventHandler) => { handler = h; },
    getHandler: () => handler!,
    spawn: vi.fn(() => {
      if (init.spawnStartsProcess !== false) state.running = true;
      return 8899;
    }),
    // Mirrors the real ProcessManager.kill: fires the "killed" event
    // SYNCHRONOUSLY (fire-and-forget, not awaited — see processes.ts) before
    // returning, so tests that register a real event handler exercise the
    // same dispose()-clears-pendingTurn ordering production relies on.
    kill: vi.fn((chatId?: number, topicId?: number) => {
      state.killedTokens.push(state.token);
      state.running = false;
      if (handler && chatId !== undefined && topicId !== undefined) {
        void handler({ chatId, topicId, event: "killed" });
      }
    }),
  };
}

function fakeBot() {
  const sent: string[] = [];
  return {
    sent,
    api: {
      sendMessage: vi.fn(async (_chatId: number, text: string) => { sent.push(text); return { message_id: 1 }; }),
      sendChatAction: vi.fn(async () => true),
      editMessageText: vi.fn(async () => true),
    },
    // registerMessageHandlers wires bot.on(...) handlers we never exercise
    // here (this file drives the event handler directly via pm.getHandler());
    // stub them so registration itself doesn't throw.
    on: vi.fn(),
    hears: vi.fn(),
  };
}

/** Route the global fetch: GET /ready vs the chat POST to the channel root. */
function stubFetch(routes: {
  ready?: () => Promise<unknown>;
  post?: (body: string) => Promise<unknown>;
} = {}) {
  const posts: string[] = [];
  const okResponse = { ok: true, status: 200, text: async () => "ok" };
  const impl = vi.fn((url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.endsWith("/ready")) return (routes.ready ?? (async () => ({ status: 200 })))();
    posts.push(init?.body ?? "");
    return (routes.post ?? (async () => okResponse))(init?.body ?? "");
  });
  vi.stubGlobal("fetch", impl);
  return { posts, impl };
}

// Table-driven regression test for sendToChannel's failure-handling contract:
// for each readiness outcome (waitForReady/readinessDecision) crossed with
// running/not-running, assert the returned DeliveryResult, whether the right
// (and only the right) generation got killed, and what the user was told.
// This pins the invariants documented in CLAUDE.md's "Generation-aware spawn
// lifecycle" and "Readiness for delivery needs a green port" bullets, which
// trace back to two live incidents (2026-08-13, 2026-08-18) where a healthy session got killed on a timing artifact.
describe("sendToChannel outcome matrix", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-stc-"));
    TOPIC += 1; // fresh composite key per test — the topic-runtime registry is module-level
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    removeTopicRuntime(CHAT, TOPIC);
    rmSync(dir, { recursive: true });
  });

  it("spawn → ready: delivered, stall timer armed, nothing killed", async () => {
    const pm = fakePm();
    const bot = fakeBot();
    const { posts } = stubFetch();

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: true });
    expect(pm.spawn).toHaveBeenCalledOnce();
    expect(pm.kill).not.toHaveBeenCalled();
    expect(pm.beginTurn).toHaveBeenCalledWith(CHAT, TOPIC);
    const body = JSON.parse(posts[0]);
    expect(body.content).toBe("hello");
    expect(body.meta.sender).toBe("user");
    expect(body.meta.topic_id).toBe(String(TOPIC));
    const rt = topicRuntime(CHAT, TOPIC);
    expect(rt.timers.has("stall")).toBe(true);
    expect(rt.pendingTurn).toHaveLength(1);
    expect(rt.pendingTurn[0]).toMatchObject({ content: "hello", resent: false });
    expect(rt.pendingTurn[0].id).toBeTypeOf("string");
    // The queued envelope's id is the one that went out on the wire.
    expect(body.meta.delivery_id).toBe(rt.pendingTurn[0].id);
  });

  it("spawn → blocked: not delivered, THIS generation killed, cooldown recorded, user told", async () => {
    const pm = fakePm({ status: "blocked" });
    const bot = fakeBot();
    stubFetch();

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "channels are blocked org-wide" });
    expect(pm.state.killedTokens).toEqual(["gen-1"]);
    expect(topicRuntime(CHAT, TOPIC).channelBlockedAt).toBeTypeOf("number");
    expect(bot.sent.some((t) => t.includes("Channels are disabled"))).toBe(true);
  });

  it("blocked cooldown: refuses without spawning", async () => {
    const pm = fakePm();
    const bot = fakeBot();
    stubFetch();
    topicRuntime(CHAT, TOPIC).channelBlockedAt = Date.now();

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "channels are blocked org-wide" });
    expect(pm.spawn).not.toHaveBeenCalled();
    expect(bot.sent.some((t) => t.includes("Channels are disabled"))).toBe(true);
  });

  it("spawn → gone (replaced mid-wait): no kill — the topic belongs to someone else now", async () => {
    const pm = fakePm();
    // First getSpawnToken() call captures the generation; every later call sees a
    // NEWER token, as if /new replaced the process mid-wait.
    let calls = 0;
    pm.getSpawnToken.mockImplementation(() => (calls++ === 0 ? "gen-1" : "gen-2"));
    const bot = fakeBot();
    stubFetch();

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "the session was restarted mid-delivery" });
    expect(pm.kill).not.toHaveBeenCalled();
    expect(bot.sent.some((t) => t.includes("restarted before your message was delivered"))).toBe(true);
  });

  it("spawn → died: killed (same generation), user told to /new", async () => {
    const pm = fakePm({ spawnStartsProcess: false }); // process exits immediately
    const bot = fakeBot();
    stubFetch();

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "Claude Code exited during startup" });
    expect(pm.state.killedTokens).toEqual(["gen-1"]);
    expect(bot.sent.some((t) => t.includes("exited right after starting"))).toBe(true);
  });

  it("spawn → timeout: retried once, then reported as failed to start", async () => {
    vi.useFakeTimers();
    const pm = fakePm({ status: "pending" }); // hooks never confirm
    const bot = fakeBot();
    stubFetch({ ready: async () => { throw new Error("ECONNREFUSED"); } }); // port never binds

    const promise = sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);
    await vi.advanceTimersByTimeAsync(130_000); // two full 60s waitForReady windows
    const result = await promise;

    expect(result).toEqual({ ok: false, reason: "Claude Code timed out starting" });
    expect(pm.spawn).toHaveBeenCalledTimes(2); // cold-start retry happened
    expect(pm.state.killedTokens).toEqual(["gen-1", "gen-1"]); // each dead generation cleared
    expect(bot.sent.some((t) => t.includes("failed to start"))).toBe(true);
  });

  it("running → ready → POST network failure: THIS generation killed, user told", async () => {
    const pm = fakePm({ running: true });
    const bot = fakeBot();
    stubFetch({ post: async () => { throw new Error("socket hang up"); } });

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "the channel POST failed" });
    expect(pm.state.killedTokens).toEqual(["gen-1"]);
    expect(bot.sent.some((t) => t.includes("Failed to deliver your message"))).toBe(true);
  });

  it("running → POST failure while a NEWER generation took over: kill NOT called", async () => {
    const pm = fakePm({ running: true });
    const bot = fakeBot();
    stubFetch({
      post: async () => {
        pm.state.token = "gen-2"; // /new landed while the fetch was in flight
        throw new Error("socket hang up");
      },
    });

    const result = await sendToChannel(CHAT, TOPIC, "/tmp/p", "hello", pm as any, bot as any, dir);

    expect(result).toEqual({ ok: false, reason: "the channel POST failed" });
    expect(pm.kill).not.toHaveBeenCalled();
  });
});

// The StopFailure error branch (registerMessageHandlers' event handler in
// message.ts) reads rt.takeResendable() and re-delivers every queued envelope
// through the real sendToChannel — exercised end-to-end here (real project,
// real fetch stubbing, real spawn/POST plumbing) rather than mocked, since the
// whole point is to pin down what actually goes out on the wire.
describe("StopFailure auto-resend uses the pending-turn ledger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-ledger-"));
    TOPIC += 1;
    saveProjects({ projects: [{ name: "P", path: "/tmp/p", chatId: CHAT, topicId: TOPIC, createdAt: "" }] }, dir);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearConfigCache();
    removeTopicRuntime(CHAT, TOPIC);
    rmSync(dir, { recursive: true });
  });

  it("resends every unresent envelope in order with its original delivery id, and a repeat failure resends nothing new", async () => {
    const pm = fakePm({ running: true });
    const bot = fakeBot();
    const { posts } = stubFetch();
    registerMessageHandlers(bot as any, pm as any, dir);

    // Two messages land in the same turn — both queue.
    await sendToChannel(CHAT, TOPIC, "/tmp/p", "first", pm as any, bot as any, dir);
    await sendToChannel(CHAT, TOPIC, "/tmp/p", "second", pm as any, bot as any, dir);
    expect(posts).toHaveLength(2);
    const firstId = JSON.parse(posts[0]).meta.delivery_id;
    const secondId = JSON.parse(posts[1]).meta.delivery_id;
    expect(firstId).not.toBe(secondId);

    // StopFailure: the process is killed, then both envelopes are resent.
    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "error", text: "server_error" } as ProcessEvent);

    expect(pm.state.killedTokens).toEqual(["gen-1"]);
    expect(bot.sent.some((t) => t.includes("resending your last 2 messages"))).toBe(true);
    expect(posts).toHaveLength(4);
    const resend1 = JSON.parse(posts[2]);
    const resend2 = JSON.parse(posts[3]);
    expect(resend1.content).toBe("first");
    expect(resend2.content).toBe("second");
    // Same delivery ids as the originals — the channel server's dedupe is what
    // makes a resend safe if the original actually landed.
    expect(resend1.meta.delivery_id).toBe(firstId);
    expect(resend2.meta.delivery_id).toBe(secondId);

    // A second StopFailure right after finds an empty resendable set (both
    // envelopes already marked resent) — falls back to the generic notice,
    // no new POSTs, no loop.
    bot.sent.length = 0;
    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "error", text: "server_error" } as ProcessEvent);
    expect(posts).toHaveLength(4);
    expect(bot.sent.some((t) => t.includes("resending"))).toBe(false);
    expect(bot.sent.some((t) => t.includes("send your message again"))).toBe(true);
  });

  it("done clears the queue — a StopFailure after a completed turn falls back to the generic notice", async () => {
    const pm = fakePm({ running: true });
    const bot = fakeBot();
    const { posts } = stubFetch();
    registerMessageHandlers(bot as any, pm as any, dir);

    await sendToChannel(CHAT, TOPIC, "/tmp/p", "first", pm as any, bot as any, dir);
    expect(topicRuntime(CHAT, TOPIC).pendingTurn).toHaveLength(1);

    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "done" } as ProcessEvent);
    expect(topicRuntime(CHAT, TOPIC).pendingTurn).toEqual([]);

    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "error", text: "server_error" } as ProcessEvent);
    expect(posts).toHaveLength(1); // no resend POST — the queue was empty
    expect(bot.sent.some((t) => t.includes("send your message again"))).toBe(true);
    expect(bot.sent.some((t) => t.includes("resending"))).toBe(false);
  });

  // Fix round 1 regression: a StopFailure that lands right after a Cancel-turn
  // kill must NEVER auto-resend the message whose work the user explicitly
  // asked to stop — and the queue it would have resent from must not leak
  // into a LATER, unrelated StopFailure on a fresh process either.
  it("a cancelled turn's StopFailure never resends, and the queue is empty afterward — a later StopFailure on a new process resends nothing", async () => {
    const pm = fakePm({ running: true, cancelPending: true });
    const bot = fakeBot();
    const { posts } = stubFetch();
    registerMessageHandlers(bot as any, pm as any, dir);

    await sendToChannel(CHAT, TOPIC, "/tmp/p", "cancel me", pm as any, bot as any, dir);
    expect(topicRuntime(CHAT, TOPIC).pendingTurn).toHaveLength(1);

    // The interrupted turn ends in StopFailure while the cancel is pending.
    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "error", text: "server_error" } as ProcessEvent);

    // No resend went out, and the neutral cancellation notice was shown instead.
    expect(posts).toHaveLength(1);
    expect(bot.sent.some((t) => t.includes("resending"))).toBe(false);
    expect(bot.sent.some((t) => t.includes("cancellation was in progress"))).toBe(true);
    // The kill's dispose() dropped the stale envelope — nothing survives to be
    // misread as pending work by a later, unrelated failure.
    expect(topicRuntime(CHAT, TOPIC).pendingTurn).toEqual([]);

    // The exact regression: on the fresh (respawned) process the user sends a
    // brand-new, unrelated message, which DOES queue — then an ordinary
    // (non-cancelled) StopFailure hits. Only the new message may be resent;
    // the cancelled one ("cancel me") must never reappear on the wire.
    bot.sent.length = 0;
    pm.hasCancelPending.mockReturnValue(false);
    await sendToChannel(CHAT, TOPIC, "/tmp/p", "unrelated later message", pm as any, bot as any, dir);
    await pm.getHandler()({ chatId: CHAT, topicId: TOPIC, event: "error", text: "server_error" } as ProcessEvent);

    expect(bot.sent.some((t) => t.includes("resending your last message."))).toBe(true);
    const bodies = posts.map((p) => JSON.parse(p).content as string);
    // "cancel me" was POSTed exactly once — its original (never-cancelled)
    // delivery — and must NOT be re-POSTed here as part of this later resend.
    expect(bodies.filter((c) => c === "cancel me")).toHaveLength(1);
    expect(bodies.filter((c) => c === "unrelated later message")).toHaveLength(2); // original + its one resend
  });
});
