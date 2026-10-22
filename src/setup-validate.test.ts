import { describe, it, expect } from "vitest";
import { parseOwnerIds, validateBotToken } from "./setup-validate.js";

const jsonRes = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe("parseOwnerIds", () => {
  it("accepts comma-separated numeric ids", () => {
    expect(parseOwnerIds("123456789, 123")).toEqual({ ok: true, ids: [123456789, 123] });
  });

  it("rejects empty input", () => {
    const r = parseOwnerIds("  ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it("rejects a lone comma with nothing between", () => {
    const r = parseOwnerIds(",,");
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric ids and names them", () => {
    const r = parseOwnerIds("abc,123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("abc");
  });

  it("rejects a handle typed instead of a numeric id", () => {
    const r = parseOwnerIds("@myname");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("@myname");
  });
});

describe("validateBotToken", () => {
  it("rejects a malformed token without a network call", async () => {
    const r = await validateBotToken("not-a-token", async () => {
      throw new Error("must not be called");
    });
    expect(r.ok).toBe(false);
  });

  it("accepts on getMe ok", async () => {
    const r = await validateBotToken("123456:ABCDEFghijklmnopqrstuv", async () =>
      jsonRes({ ok: true, result: { username: "mybot" } }),
    );
    expect(r).toEqual({ ok: true, username: "mybot" });
  });

  it("relays Telegram's rejection", async () => {
    const r = await validateBotToken("123456:ABCDEFghijklmnopqrstuv", async () =>
      jsonRes({ ok: false, description: "Unauthorized" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unauthorized");
  });

  it("distinguishes a network failure from an invalid token", async () => {
    const r = await validateBotToken("123456:ABCDEFghijklmnopqrstuv", async () => {
      throw new Error("fetch failed");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain("Telegram rejected");
      expect(r.error.toLowerCase()).toContain("reach");
    }
  });

  it("falls back to '?' when getMe omits a username", async () => {
    const r = await validateBotToken("123456:ABCDEFghijklmnopqrstuv", async () =>
      jsonRes({ ok: true, result: {} }),
    );
    expect(r).toEqual({ ok: true, username: "?" });
  });
});
