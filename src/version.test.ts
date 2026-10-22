import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getVersion, packageVersion } from "./version.js";

describe("version stamping", () => {
  beforeEach(() => {
    vi.stubEnv("TELECLAUDE_BUILD_COMMIT", "abc1234");
    vi.stubEnv("TELECLAUDE_BUILD_VERSION", "9.9.9");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("prefers the build-time stamp over git", () => {
    expect(getVersion()).toEqual({ version: "9.9.9", commit: "abc1234", branch: "release", dirty: false });
  });

  it("packageVersion prefers the stamp", () => {
    expect(packageVersion()).toBe("9.9.9");
  });

  it("falls back to git/package.json when unstamped", () => {
    vi.unstubAllEnvs();
    const v = getVersion();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/); // from package.json
    expect(v.commit.length).toBeGreaterThan(0); // sha in a checkout, "unknown" outside one
  });
});
