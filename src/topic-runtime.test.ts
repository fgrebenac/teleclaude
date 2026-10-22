import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerBag, topicRuntime, peekTopicRuntime, removeTopicRuntime } from "./topic-runtime.js";

const CHAT = -100999;
const TOPIC = 7;

describe("TimerBag", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("setTimeout arms a one-shot that empties its slot when it fires", () => {
    const bag = new TimerBag();
    const fn = vi.fn();
    bag.setTimeout("stall", fn, 1000);
    expect(bag.has("stall")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledOnce();
    expect(bag.has("stall")).toBe(false);
  });

  it("setting a slot replaces (and cancels) whatever it held", () => {
    const bag = new TimerBag();
    const first = vi.fn();
    const second = vi.fn();
    bag.setTimeout("stall", first, 1000);
    bag.setTimeout("stall", second, 1000);
    vi.advanceTimersByTime(2000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("setTimeout returns the handle, and get() reports the live one for identity checks", () => {
    const bag = new TimerBag();
    const handle = bag.setTimeout("stall", () => {}, 1000);
    expect(bag.get("stall")).toBe(handle);
    const replacement = bag.setTimeout("stall", () => {}, 1000);
    expect(bag.get("stall")).toBe(replacement);
    expect(bag.get("stall")).not.toBe(handle);
  });

  it("setInterval repeats until cleared and does not self-empty", () => {
    const bag = new TimerBag();
    const fn = vi.fn();
    bag.setInterval("typing", fn, 100);
    vi.advanceTimersByTime(350);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(bag.has("typing")).toBe(true);
    bag.clear("typing");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("clear on an empty slot is a no-op", () => {
    const bag = new TimerBag();
    expect(() => bag.clear("softWarn")).not.toThrow();
  });

  it("clearAll cancels every slot — timeout and interval alike", () => {
    const bag = new TimerBag();
    const a = vi.fn();
    const b = vi.fn();
    bag.setTimeout("doneDebounce", a, 1000);
    bag.setInterval("typing", b, 100);
    expect(bag.size).toBe(2);
    bag.clearAll();
    expect(bag.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});

describe("TopicRuntime registry", () => {
  afterEach(() => { removeTopicRuntime(CHAT, TOPIC); });

  it("topicRuntime get-or-creates exactly one runtime per (chat, topic)", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    expect(topicRuntime(CHAT, TOPIC)).toBe(rt);
    expect(rt.chatId).toBe(CHAT);
    expect(rt.topicId).toBe(TOPIC);
    // Same topic id in a DIFFERENT chat is a different runtime — composite keys.
    const other = topicRuntime(CHAT - 1, TOPIC);
    expect(other).not.toBe(rt);
    removeTopicRuntime(CHAT - 1, TOPIC);
  });

  it("peekTopicRuntime never creates", () => {
    expect(peekTopicRuntime(CHAT, TOPIC)).toBeUndefined();
    const rt = topicRuntime(CHAT, TOPIC);
    expect(peekTopicRuntime(CHAT, TOPIC)).toBe(rt);
  });

  it("dispose clears every timer and is idempotent", () => {
    vi.useFakeTimers();
    const rt = topicRuntime(CHAT, TOPIC);
    const fn = vi.fn();
    rt.timers.setTimeout("stall", fn, 1000);
    rt.timers.setInterval("typing", fn, 100);
    rt.dispose();
    expect(rt.timers.size).toBe(0);
    expect(() => rt.dispose()).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("dispose clears the tracked warning message", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.warning = { messageId: 42, severity: "hard" };
    rt.dispose();
    expect(rt.warning).toBeUndefined();
  });

  it("removeTopicRuntime disposes and forgets — the next topicRuntime call starts fresh", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.timers.setInterval("typing", () => {}, 60_000);
    removeTopicRuntime(CHAT, TOPIC);
    expect(peekTopicRuntime(CHAT, TOPIC)).toBeUndefined();
    const fresh = topicRuntime(CHAT, TOPIC);
    expect(fresh).not.toBe(rt);
    expect(fresh.timers.size).toBe(0);
  });

  it("dispose resets process-scoped scratch but keeps topic memory", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.lastReplyMsg = { chatId: CHAT, messageId: 5, text: "x", replyCount: 3 };
    rt.replyCount = 2;
    rt.lastUserMessageAt = 123;
    rt.channelBlockedAt = 456;
    const ready = Promise.resolve<number | null>(8801);
    rt.topicReady = ready;

    rt.dispose();

    // Process-scoped: gone with the process.
    expect(rt.lastReplyMsg).toBeUndefined();
    expect(rt.replyCount).toBe(0);
    // Topic memory: MUST survive — each field's doc says what breaks otherwise.
    expect(rt.lastUserMessageAt).toBe(123);
    expect(rt.channelBlockedAt).toBe(456);
    expect(rt.topicReady).toBe(ready);
  });

  it("dispose ALSO clears the pending-turn queue — a process death that isn't a completed turn must drop stale envelopes (fix round 1: a StopFailure after a Cancel-turn kill was resending the message the user just cancelled)", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.noteDelivered({ id: "a", content: "do the thing", sentAt: 1, resent: false });
    expect(rt.pendingTurn).toHaveLength(1);

    rt.dispose();

    expect(rt.pendingTurn).toEqual([]);
  });

  it("noteDelivered queues envelopes, dedupes by id, and caps at 10 (oldest out)", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    for (let i = 0; i < 12; i++) {
      rt.noteDelivered({ id: `e${i}`, content: `m${i}`, sentAt: i, resent: false });
    }
    rt.noteDelivered({ id: "e11", content: "dup", sentAt: 99, resent: false }); // same id → dropped
    expect(rt.pendingTurn).toHaveLength(10);
    expect(rt.pendingTurn[0].id).toBe("e2");
    expect(rt.pendingTurn[9]).toEqual({ id: "e11", content: "m11", sentAt: 11, resent: false });
  });

  it("takeResendable returns unresent envelopes in order and marks them before returning", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.noteDelivered({ id: "a", content: "first", sentAt: 1, resent: true });  // already resent once
    rt.noteDelivered({ id: "b", content: "second", sentAt: 2, resent: false });
    rt.noteDelivered({ id: "c", content: "third", sentAt: 3, resent: false });

    const eligible = rt.takeResendable();
    expect(eligible.map((e) => e.id)).toEqual(["b", "c"]);
    expect(eligible.every((e) => e.resent)).toBe(true);
    // A second failure right after finds nothing to resend — no loop.
    expect(rt.takeResendable()).toEqual([]);
  });

  it("clearTurn empties the queue directly (done path); dispose empties it too (process-death path) — both land on the same empty state", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    rt.noteDelivered({ id: "a", content: "x", sentAt: 1, resent: false });
    rt.clearTurn();
    expect(rt.pendingTurn).toEqual([]);

    rt.noteDelivered({ id: "b", content: "y", sentAt: 2, resent: false });
    rt.dispose();
    expect(rt.pendingTurn).toEqual([]);
  });

  it("counts pendingTurn evictions and resets with the queue", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    for (let i = 0; i < 13; i++) {
      rt.noteDelivered({ id: `d${i}`, content: `m${i}`, sentAt: i, resent: false });
    }
    // 13 delivered, cap 10 → 3 evicted.
    expect(rt.pendingEvictedCount).toBe(3);
    rt.clearTurn();
    expect(rt.pendingEvictedCount).toBe(0);
  });

  it("dispose also resets the evicted counter", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    for (let i = 0; i < 12; i++) {
      rt.noteDelivered({ id: `e${i}`, content: `m${i}`, sentAt: i, resent: false });
    }
    expect(rt.pendingEvictedCount).toBe(2);
    rt.dispose();
    expect(rt.pendingEvictedCount).toBe(0);
  });

  it("a dedupe hit (same id already queued) does not count as an eviction", () => {
    const rt = topicRuntime(CHAT, TOPIC);
    for (let i = 0; i < 10; i++) {
      rt.noteDelivered({ id: `f${i}`, content: `m${i}`, sentAt: i, resent: false });
    }
    rt.noteDelivered({ id: "f9", content: "dup", sentAt: 99, resent: false }); // dedupe, no push, no shift
    expect(rt.pendingEvictedCount).toBe(0);
  });
});
