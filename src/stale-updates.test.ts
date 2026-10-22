import { describe, it, expect } from "vitest";
import { isStaleMessage, MAX_UPDATE_AGE_MS } from "./stale-updates.js";

describe("isStaleMessage", () => {
  const nowMs = 1_700_000_000_000;
  it("fresh message passes", () => {
    expect(isStaleMessage(nowMs / 1000 - 30, nowMs)).toBe(false);
  });
  it("message older than the cap is stale", () => {
    expect(isStaleMessage(nowMs / 1000 - MAX_UPDATE_AGE_MS / 1000 - 1, nowMs)).toBe(true);
  });
  it("message exactly at the threshold is not stale", () => {
    expect(isStaleMessage(nowMs / 1000 - MAX_UPDATE_AGE_MS / 1000, nowMs)).toBe(false);
  });
  it("no date (non-message updates) never stale", () => {
    expect(isStaleMessage(undefined, nowMs)).toBe(false);
  });
});
