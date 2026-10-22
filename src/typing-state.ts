/**
 * Pure decision logic for the Telegram "typing…" indicator.
 *
 * The indicator should stay on while Claude is working and stop only once the
 * FINAL update is confirmed sent. This function maps an incoming process event
 * (plus how many replies the current turn produced) to the action the caller
 * should take on the typing timers. Keeping it pure makes the lifecycle testable
 * without a live bot or ProcessManager.
 */

import type { ProcessEventName } from "./processes.js";

export type TypingAction =
  | { kind: "stop" }                      // stop immediately (terminal event)
  | { kind: "schedule"; delayMs: number } // stop after delayMs unless reset by activity
  | { kind: "keep" }                      // (re)start and cancel any pending stop
  | { kind: "none" };                     // not typing-relevant

export interface TypingTimings {
  /** Settle margin after a confirmed final send (reply delivered / forwarded). */
  settleMs: number;
  /** Fallback when no send is confirmed (e.g. `done` with no reply and nothing forwarded). */
  graceMs: number;
}

// Events that mean "Claude is still actively working" → keep the indicator alive.
// NOTE: subagent_start/subagent_stop are deliberately excluded. A `subagent_stop`
// reliably arrives 2-3s AFTER the final `done`; treating it as activity would cancel
// the pending stop and re-arm typing with no following `done` to ever stop it again
// (indicator stuck on). During real subagent work the main turn hasn't `done`'d yet,
// so typing stays on without needing these events.
const ACTIVITY_EVENTS = new Set<ProcessEventName>([
  "reply", "tool_use", "compact", "compacted",
]);

export function typingActionFor(event: ProcessEventName, replyCount: number, t: TypingTimings): TypingAction {
  // Terminal — the session is gone or errored, stop at once.
  if (event === "error" || event === "disconnected" || event === "killed") {
    return { kind: "stop" };
  }
  // Turn finished. With a reply, the final update is already delivered (the reply
  // callback posts after the Telegram send), so a short settle is enough. Without
  // a reply, a /forward send is still coming → wait the longer grace for `forwarded`.
  if (event === "done") {
    return { kind: "schedule", delayMs: replyCount > 0 ? t.settleMs : t.graceMs };
  }
  // The /forward fallback message has actually been sent — final update confirmed.
  if (event === "forwarded") {
    return { kind: "schedule", delayMs: t.settleMs };
  }
  // Any sign of work — keep the indicator alive and cancel a pending stop.
  if (ACTIVITY_EVENTS.has(event)) {
    return { kind: "keep" };
  }
  return { kind: "none" };
}

export interface KeepAliveTimings {
  /** How long an UNBACKED indicator may run without further activity before it
   *  auto-stops. Unbacked = no in-flight delivery guarantees a `done` that
   *  will stop it: a run resurrected by activity from a full stop, or the
   *  window after a turn's `done` already scheduled its settle stop. The cap
   *  is what keeps a stray post-turn event (e.g. a lingering parallel
   *  subagent's tool_use) from pinning the indicator on until the next turn. */
  unbackedIdleCapMs: number;
  /** Minimum gap between immediate re-sends (nudges) of an already-running
   *  indicator, so a burst of parallel tool_use events doesn't spam
   *  sendChatAction. */
  nudgeThrottleMs: number;
}

export interface KeepAliveState {
  /** The 4s sendChatAction interval is armed. */
  intervalRunning: boolean;
  /** No delivery-backed `done` is guaranteed to stop the current run — see
   *  unbackedIdleCapMs. */
  unbacked: boolean;
  /** ms since the last sendChatAction actually went out. */
  msSinceLastAction: number;
  /** The triggering event confirms a bot message just reached the chat (a
   *  `reply` callback) — the client definitely cleared the typing status, so
   *  recency of our own last action is irrelevant and the throttle must not
   *  suppress the re-send. */
  statusJustCleared: boolean;
}

export interface KeepAliveAction {
  /** (Re)start the interval — this is a resurrection, so cap it. */
  start: boolean;
  /** (Re)arm the auto-stop cap at this delay (unbacked mode only). */
  idleCapMs?: number;
  /** Fire one sendChatAction right now: Telegram clients clear the typing
   *  status whenever a message from the bot arrives, and the next interval
   *  tick can be up to 4s away. */
  sendNow: boolean;
}

/** What an activity event does to an indicator, given how it's currently
 *  running. A start (from `startTyping`) sends its own immediate action, so
 *  `sendNow` stays false there. */
export function keepAliveActionFor(state: KeepAliveState, t: KeepAliveTimings): KeepAliveAction {
  if (!state.intervalRunning) {
    return { start: true, idleCapMs: t.unbackedIdleCapMs, sendNow: false };
  }
  const sendNow = state.statusJustCleared || state.msSinceLastAction >= t.nudgeThrottleMs;
  if (state.unbacked) {
    return { start: false, idleCapMs: t.unbackedIdleCapMs, sendNow };
  }
  return { start: false, sendNow };
}
