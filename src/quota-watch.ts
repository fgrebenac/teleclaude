import type { QuotaBucket, QuotaResponse } from "./quota.js";

/**
 * Pure decision logic for proactive quota alerts: which buckets crossed the
 * threshold and haven't been alerted for their current reset window yet.
 * The key ties an alert to (bucket, level, reset window), so each bucket alerts
 * at most once per level per window and automatically re-arms after it resets.
 *
 * Two levels:
 *  - "warn"      — crossed the configured threshold (e.g. 90%)
 *  - "exhausted" — hit 100%: a final red warning, then the caller schedules a
 *                  reset notice instead of repeating every poll.
 */
export type QuotaAlertLevel = "warn" | "exhausted";

export interface QuotaAlert {
  /** Bucket field name, e.g. "five_hour" — used for the follow-up reset check. */
  field: string;
  label: string;
  utilization: number;
  resetsAt: string | null;
  level: QuotaAlertLevel;
  /** Dedupe key — caller adds it to `alerted` after sending. */
  key: string;
}

const BUCKETS: Array<{ field: keyof QuotaResponse; label: string }> = [
  { field: "five_hour", label: "5h session" },
  { field: "seven_day", label: "Weekly" },
  { field: "seven_day_opus", label: "Weekly Opus" },
  { field: "seven_day_sonnet", label: "Weekly Sonnet" },
];

export function bucketLabel(field: string): string {
  return BUCKETS.find((b) => b.field === field)?.label ?? field;
}

/**
 * The API stamps `resets_at` with the *request's* sub-second precision
 * (…T13:30:00.428525+00:00), so the raw string differs on every poll even
 * though the window boundary is the same. Floor to the minute so the dedupe
 * key is stable across polls; fall back to the raw string if unparseable.
 */
export function resetWindowKey(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "unknown";
  const ms = new Date(resetsAt).getTime();
  if (Number.isNaN(ms)) return resetsAt;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

export function quotaAlertsFor(
  q: QuotaResponse,
  thresholdPct: number,
  alerted: ReadonlySet<string>,
): QuotaAlert[] {
  if (thresholdPct <= 0) return []; // disabled
  const out: QuotaAlert[] = [];
  for (const { field, label } of BUCKETS) {
    const b = q[field] as QuotaBucket | null | undefined;
    if (!b || b.utilization == null) continue;
    if (b.utilization < thresholdPct) continue;
    const level: QuotaAlertLevel = b.utilization >= 100 ? "exhausted" : "warn";
    const key = `${String(field)}:${level}:${resetWindowKey(b.resets_at)}`;
    if (alerted.has(key)) continue;
    out.push({ field: String(field), label, utilization: b.utilization, resetsAt: b.resets_at, level, key });
  }
  return out;
}

/** Cap on how far ahead a reset notice is scheduled (weekly buckets can be days out). */
export const MAX_RESET_DELAY_MS = 7 * 24 * 3_600_000;

/**
 * Delay until the reset notice for `resetsAt` should fire, with a small buffer
 * so the quota is actually refreshed by then. Returns null when there's no
 * usable reset time; clamps to [buffer, MAX_RESET_DELAY_MS].
 */
export function resetNoticeDelayMs(
  resetsAt: string | null | undefined,
  now: number,
  bufferMs = 60_000,
): number | null {
  if (!resetsAt) return null;
  const at = new Date(resetsAt).getTime();
  if (Number.isNaN(at)) return null;
  // Compare the *reset time* against the cap, not the buffered delay — a weekly
  // bucket that resets exactly 7 days out would otherwise be rejected and get
  // no notice at all.
  if (at - now > MAX_RESET_DELAY_MS) return null;
  return Math.max(bufferMs, at - now + bufferMs);
}
