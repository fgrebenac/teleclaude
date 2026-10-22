import { getQuota, type QuotaBucket, type QuotaResponse } from "./quota.js";

/**
 * Quota gate for SCHEDULED runs (never interactive messages): while the chosen
 * bucket is at/above the threshold, the scheduler defers due jobs instead of
 * delivering them. Pure decision here; the deferral itself lives in
 * scheduler.ts so retry/attempt semantics stay in one place.
 *
 * Fails OPEN on unknown quota — an unreachable quota API must degrade to
 * "schedules run as before", never to silently paused automation.
 */

export type GateBucket = "five_hour" | "seven_day";

export interface GateDecision {
  gated: boolean;
  utilization?: number;
  resetsAt?: string | null;
}

export function gateDecision(
  q: QuotaResponse | null | undefined,
  thresholdPct: number,
  bucket: GateBucket = "five_hour",
): GateDecision {
  if (thresholdPct <= 0) return { gated: false };
  if (!q) return { gated: false };
  const b = q[bucket] as QuotaBucket | null | undefined;
  if (!b || b.utilization == null) return { gated: false };
  if (b.utilization >= thresholdPct) {
    return { gated: true, utilization: b.utilization, resetsAt: b.resets_at };
  }
  return { gated: false, utilization: b.utilization };
}

/** getQuota() behind a TTL cache — the scheduler ticks every 30s; the quota API shouldn't. */
export class QuotaGate {
  #fetcher: () => Promise<QuotaResponse | null>;
  #ttlMs: number;
  #cache?: { at: number; q: QuotaResponse | null };

  constructor(fetcher: () => Promise<QuotaResponse | null> = getQuota, ttlMs = 10 * 60_000) {
    this.#fetcher = fetcher;
    this.#ttlMs = ttlMs;
  }

  async decide(thresholdPct: number, bucket: GateBucket, now: number): Promise<GateDecision> {
    if (thresholdPct <= 0) return { gated: false };
    if (!this.#cache || now - this.#cache.at > this.#ttlMs) {
      let q: QuotaResponse | null = null;
      try {
        q = await this.#fetcher();
      } catch {
        q = null; // unknown — fail open in gateDecision
      }
      this.#cache = { at: now, q };
    }
    return gateDecision(this.#cache.q, thresholdPct, bucket);
  }
}
