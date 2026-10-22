import { describe, it, expect } from "vitest";
import { typingActionFor, keepAliveActionFor } from "./typing-state.js";
import type { ProcessEventName } from "./processes.js";

const T = { settleMs: 2500, graceMs: 8000 };

describe("typingActionFor", () => {
  it("stops immediately on terminal events", () => {
    for (const e of ["error", "disconnected", "killed"] as const) {
      expect(typingActionFor(e, 3, T)).toEqual({ kind: "stop" });
    }
  });

  it("schedules a short settle on done when a reply was sent", () => {
    expect(typingActionFor("done", 1, T)).toEqual({ kind: "schedule", delayMs: 2500 });
    expect(typingActionFor("done", 5, T)).toEqual({ kind: "schedule", delayMs: 2500 });
  });

  it("waits the longer grace on done with no reply (forward may follow)", () => {
    expect(typingActionFor("done", 0, T)).toEqual({ kind: "schedule", delayMs: 8000 });
  });

  it("schedules the settle on forwarded (final fallback send landed)", () => {
    expect(typingActionFor("forwarded", 0, T)).toEqual({ kind: "schedule", delayMs: 2500 });
  });

  it("keeps typing alive on real activity events", () => {
    for (const e of ["reply", "tool_use", "compact", "compacted"] as const) {
      expect(typingActionFor(e, 0, T)).toEqual({ kind: "keep" });
    }
  });

  it("does NOT keep typing alive on subagent lifecycle (they trail done)", () => {
    // subagent_stop reliably arrives 2-3s after the final done — treating it as
    // activity would re-arm typing forever. Must be inert.
    expect(typingActionFor("subagent_stop", 2, T)).toEqual({ kind: "none" });
    expect(typingActionFor("subagent_start", 2, T)).toEqual({ kind: "none" });
  });

  it("returns none for unrelated events", () => {
    for (const e of ["mcp_failed", "tool_stuck", "tool_escalate"] as const) {
      expect(typingActionFor(e, 2, T)).toEqual({ kind: "none" });
    }
    // Runtime totality: event names cross an HTTP boundary, so an unknown
    // string must still map to "none" even though the type now forbids it.
    expect(typingActionFor("whatever" as ProcessEventName, 2, T)).toEqual({ kind: "none" });
  });

  it("respects custom timings", () => {
    expect(typingActionFor("done", 1, { settleMs: 1000, graceMs: 5000 })).toEqual({ kind: "schedule", delayMs: 1000 });
    expect(typingActionFor("done", 0, { settleMs: 1000, graceMs: 5000 })).toEqual({ kind: "schedule", delayMs: 5000 });
  });
});

const KA = { unbackedIdleCapMs: 300_000, nudgeThrottleMs: 1500 };

describe("keepAliveActionFor", () => {
  it("resurrects a fully stopped indicator WITH an idle cap (stray post-turn activity must not pin it on forever)", () => {
    expect(keepAliveActionFor({ intervalRunning: false, unbacked: false, msSinceLastAction: 999_999, statusJustCleared: false }, KA))
      .toEqual({ start: true, idleCapMs: 300_000, sendNow: false });
    // Already flagged unbacked (a prior resurrection capped out) — same thing.
    expect(keepAliveActionFor({ intervalRunning: false, unbacked: true, msSinceLastAction: 999_999, statusJustCleared: false }, KA))
      .toEqual({ start: true, idleCapMs: 300_000, sendNow: false });
  });

  it("pushes the idle cap forward on activity in unbacked mode, nudging when past the throttle", () => {
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: true, msSinceLastAction: 2000, statusJustCleared: false }, KA))
      .toEqual({ start: false, idleCapMs: 300_000, sendNow: true });
  });

  it("pushes the cap without a nudge when the last action was too recent", () => {
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: true, msSinceLastAction: 400, statusJustCleared: false }, KA))
      .toEqual({ start: false, idleCapMs: 300_000, sendNow: false });
  });

  it("nudges a normally-running indicator immediately (Telegram clears typing on every bot message)", () => {
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: false, msSinceLastAction: 2000, statusJustCleared: false }, KA))
      .toEqual({ start: false, sendNow: true });
  });

  it("does nothing to a normally-running indicator inside the nudge throttle", () => {
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: false, msSinceLastAction: 400, statusJustCleared: false }, KA))
      .toEqual({ start: false, sendNow: false });
  });

  it("a confirmed bot send bypasses the throttle — the status WAS just cleared, recency of our last action is irrelevant", () => {
    // e.g. the 4s interval ticked at t=4.0 and a reply landed at t=4.1: without
    // the bypass the nudge is suppressed and typing stays dark until t=8.0.
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: false, msSinceLastAction: 100, statusJustCleared: true }, KA))
      .toEqual({ start: false, sendNow: true });
    expect(keepAliveActionFor({ intervalRunning: true, unbacked: true, msSinceLastAction: 100, statusJustCleared: true }, KA))
      .toEqual({ start: false, idleCapMs: 300_000, sendNow: true });
  });
});
