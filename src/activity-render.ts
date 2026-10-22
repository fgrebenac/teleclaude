/**
 * How long to wait before rendering the next activity update.
 *
 * The live activity view is coalesced behind a timer so rapid tool events don't
 * hit Telegram's edit rate limit. But a turn that OPENS with silent tool work
 * (no reply yet → no message to edit) then showed nothing for a full second —
 * the "dead air at turn start" a user reported on 2026-08-27.
 *
 * The fix keeps the timer (so the render stays cancelable by deliverReply and by
 * /done's collapse — the invariant the rest of channel-server relies on) but uses
 * a SHORT delay for the first render of a turn: the opening activity appears
 * almost at once, while a tight burst of opening tool events still coalesces into
 * one send. Every later render in the turn uses the normal coalesce delay.
 *
 * Returns the delay in ms, or `null` to skip entirely (the turn already collapsed
 * to its summary — no more live updates).
 */
export function activityRenderDelayMs(
  collapsed: boolean,
  hasMessage: boolean,
  firstRenderMs: number,
  coalesceMs: number,
): number | null {
  if (collapsed) return null;
  return hasMessage ? coalesceMs : firstRenderMs;
}
