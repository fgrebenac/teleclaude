/**
 * Pure formatting for the opt-in per-turn receipt (/receipts):
 *   "⏱ 4m 12s · 🔧 7 tools · ~3.2k tokens out"
 *
 * The token figure is a DELTA of the session's cumulative output tokens
 * between receipts (see receiptOutputDelta in handlers/message.ts) — there is
 * no per-turn usage in the done hook, so the first receipt after a boot or
 * respawn has no baseline and omits the segment.
 */

export interface TurnStats {
  durationMs: number;
  toolCount: number;
  /** Output tokens since the previous receipt; omitted when no baseline exists. */
  outputTokens?: number;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatReceipt(stats: TurnStats): string {
  const parts = [
    `⏱ ${formatDuration(stats.durationMs)}`,
    `🔧 ${stats.toolCount} tool${stats.toolCount === 1 ? "" : "s"}`,
  ];
  if (stats.outputTokens !== undefined && stats.outputTokens >= 0) {
    parts.push(`~${formatTokens(stats.outputTokens)} tokens out`);
  }
  return parts.join(" · ");
}
