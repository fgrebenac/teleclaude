import { describe, it, expect } from "vitest";
import { DIFF_IMAGE_CALLBACK_DATA, isDiffImageCallback } from "./diff-image-callback.js";

describe("diff image callback data", () => {
  it("round-trips the exact button payload", () => {
    expect(isDiffImageCallback(DIFF_IMAGE_CALLBACK_DATA)).toBe(true);
  });

  it("rejects near-miss payloads", () => {
    expect(isDiffImageCallback("diffimg:extra")).toBe(false);
    expect(isDiffImageCallback("diffim")).toBe(false);
    expect(isDiffImageCallback("")).toBe(false);
    expect(isDiffImageCallback("digest:morning:0700")).toBe(false);
  });
});
