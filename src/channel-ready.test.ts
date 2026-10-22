import { describe, it, expect } from "vitest";
import { readinessDecision } from "./channel-ready.js";

const GRACE = 1500;
const decide = (over: Partial<Parameters<typeof readinessDecision>[0]>) =>
  readinessDecision({ channelStatus: "pending", httpStatus: 0, msSinceFirstHttpOk: undefined, graceMs: GRACE, ...over });

describe("readinessDecision", () => {
  it("REGRESSION: a hook alone is never ready — the port must answer", () => {
    // This is the 2026-08-13 / 2026-08-18 incident: hooks report "registered"
    // ~4.6s after spawn, the channel server binds its port at ~8.0s. Treating
    // the hook as readiness POSTed into a dead port ("fetch failed") and the
    // failure path then killed a healthy session.
    expect(decide({ channelStatus: "registered", httpStatus: 0 })).toBe("wait");
    expect(decide({ channelStatus: "registered", httpStatus: 503 })).toBe("wait");
  });

  it("is ready as soon as a green port is backed by a hook", () => {
    // The hook is proof no block banner is coming, which is the only thing the
    // grace wait watches for — so no need to sit through it.
    expect(decide({ channelStatus: "registered", httpStatus: 200, msSinceFirstHttpOk: 0 })).toBe("ready");
  });

  it("waits out the grace period on a green port with no hook yet", () => {
    expect(decide({ httpStatus: 200, msSinceFirstHttpOk: 0 })).toBe("wait");
    expect(decide({ httpStatus: 200, msSinceFirstHttpOk: GRACE - 1 })).toBe("wait");
    expect(decide({ httpStatus: 200, msSinceFirstHttpOk: GRACE })).toBe("ready");
  });

  it("reports a block whatever the port says", () => {
    // A blocked channel binds its port and looks healthy — that's the whole
    // reason the block signal outranks the probe.
    expect(decide({ channelStatus: "blocked", httpStatus: 200, msSinceFirstHttpOk: 9999 })).toBe("blocked");
    expect(decide({ channelStatus: "blocked", httpStatus: 0 })).toBe("blocked");
  });

  it("treats another spawn's server on a recycled port as not ready", () => {
    // 409 = the server answering still belongs to a previous spawn.
    expect(decide({ httpStatus: 409, msSinceFirstHttpOk: 9999 })).toBe("wait");
    expect(decide({ channelStatus: "registered", httpStatus: 409 })).toBe("wait");
  });

  it("keeps waiting when nothing is known yet", () => {
    expect(decide({ channelStatus: undefined, httpStatus: 0 })).toBe("wait");
  });
});
