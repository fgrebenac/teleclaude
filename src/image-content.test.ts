import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import {
  pickImageTool, downscaleCommand, imageContent, resetImageToolCache,
  LADDER, MAX_ENCODED_BYTES,
} from "./image-content.js";

const exec = promisify(execFile);

describe("pickImageTool", () => {
  it("prefers sips (macOS built-in, no install needed)", () => {
    expect(pickImageTool({ sips: true, magick: true, convert: true })).toBe("sips");
  });

  it("falls back to magick, then convert", () => {
    expect(pickImageTool({ sips: false, magick: true, convert: true })).toBe("magick");
    expect(pickImageTool({ sips: false, magick: false, convert: true })).toBe("convert");
  });

  it("returns null when the host has none of them", () => {
    expect(pickImageTool({ sips: false, magick: false, convert: false })).toBeNull();
  });
});

describe("downscaleCommand", () => {
  it("builds a sips jpeg conversion bounded by the long edge", () => {
    const { cmd, args } = downscaleCommand("sips", "/tmp/in.png", "/tmp/out.jpg", 900, 60);
    expect(cmd).toBe("sips");
    expect(args).toEqual([
      "-s", "format", "jpeg",
      "-s", "formatOptions", "60",
      "-Z", "900",
      "/tmp/in.png", "--out", "/tmp/out.jpg",
    ]);
  });

  it("never upscales with imagemagick (trailing '>' on the geometry)", () => {
    for (const tool of ["magick", "convert"] as const) {
      const { cmd, args } = downscaleCommand(tool, "/tmp/in.png", "/tmp/out.jpg", 700, 50);
      expect(cmd).toBe(tool);
      expect(args).toEqual(["/tmp/in.png", "-resize", "700x700>", "-quality", "50", "/tmp/out.jpg"]);
    }
  });

  it("passes paths through unquoted — execFile takes an argv, not a shell string", () => {
    const { args } = downscaleCommand("magick", "/tmp/a b.png", "/tmp/o.jpg", 900, 60);
    expect(args[0]).toBe("/tmp/a b.png");
  });
});

describe("LADDER", () => {
  it("descends in both dimension and quality so each rung is smaller", () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i].maxDim).toBeLessThan(LADDER[i - 1].maxDim);
      expect(LADDER[i].quality).toBeLessThan(LADDER[i - 1].quality);
    }
  });

  it("starts at a rung that fits a real text-dense screenshot under the cap", () => {
    // Measured: a 1280x800 news page screenshot converts to 75KB at 900px/q60
    // and 91KB at 900px/q70. The first rung must be the one that fits, so the
    // common case converts once.
    expect(LADDER[0]).toEqual({ maxDim: 900, quality: 60 });
    expect(MAX_ENCODED_BYTES).toBeGreaterThan(75 * 1024);
  });

  it("keeps the cap small enough for the raised MAX_MCP_OUTPUT_TOKENS ceiling", () => {
    // base64 inflates by 4/3; ~4 chars per token. processes.ts sets the ceiling
    // to 45000, and the text part of the result needs room too. (The limit's
    // real counting basis for images is undocumented — this is a margin check,
    // not a proof.)
    const approxTokens = (MAX_ENCODED_BYTES * 4) / 3 / 4;
    expect(approxTokens).toBeLessThan(40_000);
  });
});

/** A 1x1 PNG, so a host with only sips (which can't synthesize) still has input. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Detected synchronously at module scope, not in beforeAll: `it.skipIf` is
 * evaluated when the file is collected, so an async probe would always read as
 * "no converter" and silently skip every behaviour test.
 */
function detectConverter(): "magick" | "convert" | "sips" | null {
  for (const cmd of ["magick", "convert", "sips"] as const) {
    try {
      execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}
const converter = detectConverter();

describe("imageContent", () => {
  let dir: string;
  let png: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-imgtest-"));
    png = join(dir, "src.png");
    // Prefer a realistically sized fixture; fall back to the 1x1 on sips-only hosts.
    for (const cmd of ["magick", "convert"] as const) {
      try { await exec(cmd, ["-size", "1400x900", "gradient:navy-white", png]); break; } catch { /* try next */ }
    }
    if (!existsSync(png)) writeFileSync(png, TINY_PNG);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    resetImageToolCache();
  });

  it.skipIf(!converter)("returns a decodable JPEG block and leaves the source in place", async () => {
    const res = await imageContent(png);
    expect(res.block, "reason" in res ? res.reason : "").not.toBeNull();
    if (!res.block) return;
    expect(res.block.type).toBe("image");
    expect(res.block.mimeType).toBe("image/jpeg");
    const decoded = Buffer.from(res.block.data, "base64");
    // Raw base64, not a data: URI, and a real JPEG (SOI marker).
    expect(res.block.data.startsWith("data:")).toBe(false);
    expect(decoded.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(decoded.length).toBe(res.bytes);
    expect(res.bytes).toBeLessThanOrEqual(MAX_ENCODED_BYTES);
    // deliverScreenshots still needs the file for the Telegram copy.
    expect(existsSync(png)).toBe(true);
  });

  it.skipIf(!converter)("leaves no temp files behind", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("teleclaude-img-"));
    await imageContent(png);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("teleclaude-img-"));
    expect(after).toEqual(before);
  });

  it.skipIf(!converter)("reports a reason instead of throwing when the file isn't an image", async () => {
    const bogus = join(dir, "not-an-image.png");
    writeFileSync(bogus, "this is text, not a PNG");
    const res = await imageContent(bogus);
    expect(res.block).toBeNull();
    if (res.block) return;
    expect(res.reason).toMatch(/failed/i);
    // The reason is surfaced to Claude, so it has to say something useful.
    expect(res.reason.length).toBeGreaterThan(10);
  });

  it.skipIf(converter === "sips")("walks the ladder and refuses rather than inline an over-cap image", async () => {
    // Pure noise is incompressible: measured 396KB at 900px/q60 and 142KB at
    // 700px/q50, so this exercises the retry rung *and* the cap refusal. The
    // point is that it degrades to a stated reason, never to a huge payload.
    const noise = join(dir, "noise.png");
    for (const cmd of ["magick", "convert"] as const) {
      try { await exec(cmd, ["-size", "2000x2000", "xc:", "+noise", "Random", noise]); break; } catch { /* try next */ }
    }
    const res = await imageContent(noise);
    if (res.block) {
      expect(res.bytes).toBeLessThanOrEqual(MAX_ENCODED_BYTES);
    } else {
      expect(res.reason).toMatch(/after downscaling/);
    }
  });

  it.skipIf(!converter)("still succeeds on a second call (memoized tool lookup)", async () => {
    const first = await imageContent(png);
    const second = await imageContent(png);
    expect(first.block).not.toBeNull();
    expect(second.block).not.toBeNull();
  });

  it("reports a reason when the host has no downscaler at all", async () => {
    // Simulate a bare Linux box: an empty PATH makes every `command -v` fail.
    const savedPath = process.env.PATH;
    resetImageToolCache();
    process.env.PATH = "";
    try {
      const res = await imageContent(png ?? "/nonexistent.png");
      expect(res.block).toBeNull();
      if (!res.block) expect(res.reason).toMatch(/no image downscaler/);
    } finally {
      process.env.PATH = savedPath;
      resetImageToolCache();
    }
  });
});
