/**
 * With drop_pending_updates off, messages sent during a restart are delivered
 * on boot — wanted for a 15s /update window, not for an overnight outage.
 * Only *message* updates are age-checked: a callback query carries the
 * ORIGINAL alert message's date, and taps on old-but-valid buttons (resume
 * pickers, permission prompts) must keep working — their handlers already
 * tolerate staleness themselves.
 */
export const MAX_UPDATE_AGE_MS = 10 * 60_000;

export function isStaleMessage(
  messageDateSec: number | undefined,
  nowMs: number,
  maxAgeMs: number = MAX_UPDATE_AGE_MS,
): boolean {
  if (messageDateSec === undefined) return false;
  return nowMs - messageDateSec * 1000 > maxAgeMs;
}
