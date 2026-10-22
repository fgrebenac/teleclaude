/**
 * Run `attempt`; on rejection wait `delayMs` and try exactly once more. The
 * second failure propagates to the caller — this is a bounded retry for
 * transient network blips, not a delivery queue.
 */
export async function withOneRetry<T>(attempt: () => Promise<T>, delayMs: number): Promise<T> {
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return await attempt();
  }
}
