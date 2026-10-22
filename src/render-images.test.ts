import { describe, it, expect } from "vitest";
import { pageClips, DEFAULT_WIDTH, DEFAULT_PAGE_HEIGHT, DEFAULT_MAX_PAGES } from "./render-images.js";

describe("pageClips", () => {
  it("returns a single clip when content fits in one page", () => {
    expect(pageClips(1000, 2200, 10)).toEqual([{ y: 0, height: 1000 }]);
  });

  it("splits into full pages with the remainder as the last clip", () => {
    expect(pageClips(5000, 2200, 10)).toEqual([
      { y: 0, height: 2200 },
      { y: 2200, height: 2200 },
      { y: 4400, height: 600 },
    ]);
  });

  it("caps at maxPages even when content is taller", () => {
    const clips = pageClips(100_000, 2200, 10);
    expect(clips).toHaveLength(10);
    expect(clips[9]).toEqual({ y: 19_800, height: 2200 });
  });

  it("returns [] for non-positive inputs", () => {
    expect(pageClips(0, 2200, 10)).toEqual([]);
    expect(pageClips(-5, 2200, 10)).toEqual([]);
    expect(pageClips(1000, 0, 10)).toEqual([]);
    expect(pageClips(1000, 2200, 0)).toEqual([]);
  });
});

describe("defaults", () => {
  it("match the documented page geometry", () => {
    expect(DEFAULT_WIDTH).toBe(900);
    expect(DEFAULT_PAGE_HEIGHT).toBe(2200);
    expect(DEFAULT_MAX_PAGES).toBe(10);
  });
});
