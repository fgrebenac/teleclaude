import { describe, it, expect, vi } from "vitest";
import { withOneRetry } from "./retry.js";

describe("withOneRetry", () => {
  it("returns the first attempt's result when it succeeds — no second call", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withOneRetry(fn, 1)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once after a failure and returns the retry's result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce("ok");
    await expect(withOneRetry(fn, 1)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates the second failure — never a third attempt", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still down"));
    await expect(withOneRetry(fn, 1)).rejects.toThrow("still down");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
