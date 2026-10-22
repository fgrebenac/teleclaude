import { describe, it, expect } from "vitest";
import { quotaAlertsFor, resetWindowKey, resetNoticeDelayMs, bucketLabel, MAX_RESET_DELAY_MS } from "./quota-watch.js";
import type { QuotaResponse } from "./quota.js";

function quota(overrides: Partial<QuotaResponse> = {}): QuotaResponse {
  return {
    five_hour: { utilization: 50, resets_at: "2026-07-06T22:00:00Z" },
    seven_day: { utilization: 40, resets_at: "2026-07-10T00:00:00Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    ...overrides,
  };
}

const WINDOW = "2026-07-06T22:00:00.000Z";

describe("quotaAlertsFor", () => {
  it("returns nothing when all buckets are below the threshold", () => {
    expect(quotaAlertsFor(quota(), 90, new Set())).toEqual([]);
  });

  it("alerts when a bucket crosses the threshold", () => {
    const q = quota({ five_hour: { utilization: 93, resets_at: "2026-07-06T22:00:00Z" } });
    const alerts = quotaAlertsFor(q, 90, new Set());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].label).toBe("5h session");
    expect(alerts[0].field).toBe("five_hour");
    expect(alerts[0].utilization).toBe(93);
    expect(alerts[0].level).toBe("warn");
    expect(alerts[0].key).toBe(`five_hour:warn:${WINDOW}`);
  });

  it("alerts at exactly the threshold", () => {
    const q = quota({ five_hour: { utilization: 90, resets_at: null } });
    expect(quotaAlertsFor(q, 90, new Set())).toHaveLength(1);
  });

  it("does not re-alert for an already-alerted reset window", () => {
    const q = quota({ five_hour: { utilization: 95, resets_at: "2026-07-06T22:00:00Z" } });
    const alerted = new Set([`five_hour:warn:${WINDOW}`]);
    expect(quotaAlertsFor(q, 90, alerted)).toEqual([]);
  });

  it("re-arms when resets_at changes (new window)", () => {
    const q = quota({ five_hour: { utilization: 95, resets_at: "2026-07-07T03:00:00Z" } });
    const alerted = new Set([`five_hour:warn:${WINDOW}`]);
    expect(quotaAlertsFor(q, 90, alerted)).toHaveLength(1);
  });

  it("ignores sub-minute jitter in resets_at (the API restamps it every poll)", () => {
    // Same window, different microseconds — must dedupe to the same key.
    const a = quotaAlertsFor(quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00.428525+00:00" } }), 90, new Set());
    const b = quotaAlertsFor(quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00.999111+00:00" } }), 90, new Set());
    expect(a[0].key).toBe(b[0].key);
    expect(quotaAlertsFor(quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00.999111+00:00" } }), 90, new Set([a[0].key]))).toEqual([]);
  });

  it("marks a 100% bucket as exhausted", () => {
    const alerts = quotaAlertsFor(quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00Z" } }), 90, new Set());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("exhausted");
    expect(alerts[0].key).toBe(`five_hour:exhausted:${WINDOW}`);
  });

  it("still sends the exhausted alert after a warn alert in the same window", () => {
    const q = quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00Z" } });
    const alerts = quotaAlertsFor(q, 90, new Set([`five_hour:warn:${WINDOW}`]));
    expect(alerts.map((a) => a.level)).toEqual(["exhausted"]);
  });

  it("does not repeat the exhausted alert while pinned at 100%", () => {
    const q = quota({ five_hour: { utilization: 100, resets_at: "2026-07-06T22:00:00Z" } });
    expect(quotaAlertsFor(q, 90, new Set([`five_hour:exhausted:${WINDOW}`]))).toEqual([]);
  });

  it("alerts multiple buckets independently", () => {
    const q = quota({
      five_hour: { utilization: 91, resets_at: "a" },
      seven_day: { utilization: 99, resets_at: "b" },
    });
    const alerts = quotaAlertsFor(q, 90, new Set());
    expect(alerts.map((a) => a.label)).toEqual(["5h session", "Weekly"]);
  });

  it("is disabled at threshold 0", () => {
    const q = quota({ five_hour: { utilization: 100, resets_at: "a" } });
    expect(quotaAlertsFor(q, 0, new Set())).toEqual([]);
  });

  it("skips missing buckets", () => {
    const q = quota({ five_hour: null, seven_day: null });
    expect(quotaAlertsFor(q, 90, new Set())).toEqual([]);
  });
});

describe("resetWindowKey", () => {
  it("floors to the minute", () => {
    expect(resetWindowKey("2026-07-06T22:00:59.428525+00:00")).toBe("2026-07-06T22:00:00.000Z");
  });

  it("handles null and unparseable input", () => {
    expect(resetWindowKey(null)).toBe("unknown");
    expect(resetWindowKey("nonsense")).toBe("nonsense");
  });
});

describe("resetNoticeDelayMs", () => {
  const now = Date.parse("2026-07-06T20:00:00Z");

  it("returns time-to-reset plus a buffer", () => {
    expect(resetNoticeDelayMs("2026-07-06T22:00:00Z", now)).toBe(2 * 3_600_000 + 60_000);
  });

  it("floors at the buffer for a reset time already past", () => {
    expect(resetNoticeDelayMs("2026-07-06T19:00:00Z", now)).toBe(60_000);
  });

  it("returns null without a usable reset time", () => {
    expect(resetNoticeDelayMs(null, now)).toBeNull();
    expect(resetNoticeDelayMs("nonsense", now)).toBeNull();
  });

  it("schedules a weekly bucket resetting exactly 7 days out", () => {
    // The buffer must not push an exactly-7d reset over the cap and lose the notice.
    const at = new Date(now + MAX_RESET_DELAY_MS).toISOString();
    expect(resetNoticeDelayMs(at, now)).toBe(MAX_RESET_DELAY_MS + 60_000);
  });

  it("returns null when the reset is absurdly far out", () => {
    expect(resetNoticeDelayMs(new Date(now + MAX_RESET_DELAY_MS + 60_000).toISOString(), now)).toBeNull();
  });
});

describe("bucketLabel", () => {
  it("maps known fields and falls back to the raw name", () => {
    expect(bucketLabel("seven_day_opus")).toBe("Weekly Opus");
    expect(bucketLabel("mystery")).toBe("mystery");
  });
});
