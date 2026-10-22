import { log, logError } from "./log.js";
import { readAccessToken } from "./claude-auth.js";

export interface QuotaBucket {
  utilization: number;
  resets_at: string | null;
}

export interface QuotaResponse {
  five_hour: QuotaBucket | null;
  seven_day: QuotaBucket | null;
  seven_day_opus: QuotaBucket | null;
  seven_day_sonnet: QuotaBucket | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
    currency: string | null;
  } | null;
}

const RETRYABLE_STATUSES = new Set([401, 429, 500, 502, 503, 504]);

async function fetchQuotaOnce(): Promise<{ ok: true; data: QuotaResponse } | { ok: false; retryable: boolean }> {
  const token = await readAccessToken();
  if (!token) return { ok: false, retryable: false };

  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log(`[quota] fetch failed: ${res.status} ${res.statusText}`);
      return { ok: false, retryable: RETRYABLE_STATUSES.has(res.status) };
    }
    return { ok: true, data: (await res.json()) as QuotaResponse };
  } catch (err) {
    logError("[quota] fetch error:", err);
    return { ok: false, retryable: true };
  }
}

/**
 * A ~3% slice of polls fail with a transient 401/429/5xx or network error —
 * observed in production logs, not periodic with token expiry, so most look
 * like server-side flake or a token-rotation race rather than a dead
 * credential. One retry (re-reading the token, in case it rotated) clears
 * the overwhelming majority without masking a truly invalid token, which
 * fails the same way twice.
 */
export async function getQuota(): Promise<QuotaResponse | null> {
  const first = await fetchQuotaOnce();
  if (first.ok) return first.data;
  if (!first.retryable) return null;

  await new Promise((resolve) => setTimeout(resolve, 500));
  const second = await fetchQuotaOnce();
  return second.ok ? second.data : null;
}

function bar(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round(clamped / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function fmtResetIn(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? ` · resets in ${h}h ${m}m` : ` · resets in ${m}m`;
}

export function formatQuotaLines(q: QuotaResponse): string[] {
  const lines: string[] = ["<b>Quota</b>"];
  const row = (label: string, b: QuotaBucket | null | undefined) => {
    if (!b || b.utilization == null) return;
    lines.push(`${label}  <code>${bar(b.utilization)} ${b.utilization.toFixed(0)}%</code>${fmtResetIn(b.resets_at)}`);
  };
  row("5h session   ", q.five_hour);
  row("Weekly       ", q.seven_day);
  row("Weekly Opus  ", q.seven_day_opus);
  row("Weekly Sonnet", q.seven_day_sonnet);
  if (q.extra_usage?.is_enabled && q.extra_usage.utilization != null) {
    lines.push(`Extra usage  <code>${bar(q.extra_usage.utilization)} ${q.extra_usage.utilization.toFixed(0)}%</code>`);
  }
  return lines;
}
