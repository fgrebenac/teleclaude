import { describe, it, expect } from "vitest";
import { postAuthDecision, readyAuthDecision } from "./http-auth.js";

describe("postAuthDecision", () => {
  it("FAILS CLOSED on an empty server token — accepts nothing", () => {
    expect(postAuthDecision("", "anything")).toEqual({ ok: false, status: 401, body: "unauthorized" });
    expect(postAuthDecision("", undefined)).toEqual({ ok: false, status: 401, body: "unauthorized" });
  });

  it("accepts only the exact token", () => {
    expect(postAuthDecision("s3cret", "s3cret")).toEqual({ ok: true });
  });

  it("rejects a wrong, missing, or array-valued header", () => {
    expect(postAuthDecision("s3cret", "wrong").ok).toBe(false);
    expect(postAuthDecision("s3cret", undefined).ok).toBe(false);
    expect(postAuthDecision("s3cret", ["s3cret", "s3cret"]).ok).toBe(false);
  });
});

describe("readyAuthDecision", () => {
  it("never reports ready without a server token", () => {
    expect(readyAuthDecision("", undefined)).toEqual({ ok: false, status: 503, body: "no auth token" });
    expect(readyAuthDecision("", "anything").ok).toBe(false);
  });

  it("answers 409 to a different spawn's token (recycled-port protection)", () => {
    expect(readyAuthDecision("mine", "theirs")).toEqual({ ok: false, status: 409, body: "wrong spawn" });
  });

  it("tolerates a missing header when the server has a token (unchanged probe behavior)", () => {
    expect(readyAuthDecision("mine", undefined)).toEqual({ ok: true });
    expect(readyAuthDecision("mine", "mine")).toEqual({ ok: true });
  });
});
