import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Bot } from "grammy";
import type { ProcessManager } from "./processes.js";
import { requestCancel, turnTokenMatches } from "./cancel.js";

const CHAT = -100123;
const TOPIC = 42;

function makePm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    interruptTurn: vi.fn().mockReturnValue("sent"),
    getPort: vi.fn().mockReturnValue(8801),
    getSpawnToken: vi.fn().mockReturnValue("token"),
    ...overrides,
  } as unknown as ProcessManager;
}

function makeBot() {
  return { api: { sendMessage: vi.fn().mockResolvedValue(undefined) } } as unknown as Bot;
}

describe("requestCancel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports not-running when the topic has no process", async () => {
    const pm = makePm({ interruptTurn: vi.fn().mockReturnValue("not-running") });
    const bot = makeBot();
    const result = await requestCancel(bot, pm, CHAT, TOPIC);
    expect(result).toBe("not-running");
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends the interrupt, notifies the user, and asks the channel server to cancel any pending question", async () => {
    const pm = makePm();
    const bot = makeBot();
    const result = await requestCancel(bot, pm, CHAT, TOPIC);
    expect(result).toBe("sent");
    expect(pm.interruptTurn).toHaveBeenCalledWith(CHAT, TOPIC);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, "⏳ Interrupt sent…", { message_thread_id: TOPIC });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8801/cancel-ask", expect.objectContaining({ method: "POST" }));
  });

  it("never sends a follow-up nudge, even long after the request — a live test showed 'still running' fires on successes too, since a successful interrupt is supposed to leave the process running", async () => {
    const pm = makePm();
    const bot = makeBot();
    await requestCancel(bot, pm, CHAT, TOPIC);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1); // only "Interrupt sent" — nothing more, ever
  });
});

describe("turnTokenMatches", () => {
  const live = { seq: 3, nonce: "abcd" };

  it("accepts the exact live token", () => {
    expect(turnTokenMatches(live, "3", "abcd")).toBe(true);
  });

  it("rejects a stale seq or nonce — the alert is from earlier work", () => {
    expect(turnTokenMatches(live, "2", "abcd")).toBe(false);
    expect(turnTokenMatches(live, "3", "zzzz")).toBe(false);
  });

  it("rejects a tokened button when no turn is live (fresh process after respawn)", () => {
    expect(turnTokenMatches(undefined, "3", "abcd")).toBe(false);
  });

  it("accepts a bare button only while no turn has begun", () => {
    expect(turnTokenMatches(undefined, undefined, undefined)).toBe(true);
    expect(turnTokenMatches(live, undefined, undefined)).toBe(false);
  });
});
