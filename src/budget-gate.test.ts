import { describe, it, expect, vi } from "vitest";
import { gateDecision, QuotaGate } from "./budget-gate.js";
import type { QuotaResponse } from "./quota.js";

function q(util: number | null): QuotaResponse {
  return {
    five_hour: util === null ? null : { utilization: util, resets_at: "2026-08-21T12:00:00Z" },
    seven_day: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
  };
}

describe("gateDecision", () => {
  it("gates at or above the threshold, not below", () => {
    expect(gateDecision(q(95), 95).gated).toBe(true);
    expect(gateDecision(q(100), 95).gated).toBe(true);
    expect(gateDecision(q(94.9), 95).gated).toBe(false);
  });

  it("fails open on unknown quota", () => {
    expect(gateDecision(null, 95).gated).toBe(false);
    expect(gateDecision(q(null), 95).gated).toBe(false);
  });

  it("is disabled at threshold 0", () => {
    expect(gateDecision(q(100), 0).gated).toBe(false);
  });

  it("reads the requested bucket", () => {
    const quota: QuotaResponse = { ...q(10), seven_day: { utilization: 99, resets_at: null } };
    expect(gateDecision(quota, 95, "seven_day").gated).toBe(true);
    expect(gateDecision(quota, 95, "five_hour").gated).toBe(false);
  });

  it("reports utilization and resetsAt when gated", () => {
    const d = gateDecision(q(97), 95);
    expect(d.utilization).toBe(97);
    expect(d.resetsAt).toBe("2026-08-21T12:00:00Z");
  });
});

describe("QuotaGate", () => {
  it("caches the quota for the TTL and refetches after", async () => {
    const fetcher = vi.fn(async () => q(99));
    const gate = new QuotaGate(fetcher, 10_000);
    expect((await gate.decide(95, "five_hour", 0)).gated).toBe(true);
    await gate.decide(95, "five_hour", 5_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await gate.decide(95, "five_hour", 20_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats a fetcher throw as unknown quota (fail open)", async () => {
    const gate = new QuotaGate(async () => { throw new Error("net"); }, 10_000);
    expect((await gate.decide(95, "five_hour", 0)).gated).toBe(false);
  });

  it("skips the fetch entirely at threshold 0", async () => {
    const fetcher = vi.fn(async () => q(100));
    const gate = new QuotaGate(fetcher, 10_000);
    expect((await gate.decide(0, "five_hour", 0)).gated).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
