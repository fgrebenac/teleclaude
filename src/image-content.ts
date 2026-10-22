/**
 * Turn a screenshot on disk into an MCP `image` content block so Claude can
 * *see* what it captured, not just be told "screenshot sent".
 *
 * Size is the whole problem. Claude Code counts MCP image payloads against
 * MAX_MCP_OUTPUT_TOKENS (the `anthropic/maxResultSizeChars` annotation
 * explicitly does NOT apply to images), and a raw phone screenshot is
 * 300KB-1.5MB of PNG — base64 of that would blow the budget and get the whole
 * tool result replaced with a file reference. So we downscale + re-encode as
 * JPEG through whichever CLI the host has, and refuse to inline anything still
 * over the byte cap.
 */
import { execFile } from "child_process";
import { readFileSync, statSync, unlinkSync } from "fs";
import { promisify } from "util";
import { tmpdir } from "os";
import { join } from "path";

const exec = promisify(execFile);

/** Encoded JPEG bytes we're willing to inline. 90KB → ~120K base64 chars → ~30K tokens. */
export const MAX_ENCODED_BYTES = 90 * 1024;

/**
 * Downscale attempts, in order. First one under MAX_ENCODED_BYTES wins.
 * Measured against a real 1280x800 text-dense page screenshot (202KB PNG):
 * 900px/q60 → 75KB and every headline still legible; 900px/q70 → 91KB, over
 * the cap. Hence q60 on the first rung, so the common case converts once.
 */
export const LADDER: ReadonlyArray<{ maxDim: number; quality: number }> = [
  { maxDim: 900, quality: 60 },
  { maxDim: 700, quality: 50 },
];

export type ImageTool = "sips" | "magick" | "convert";

/** Pick the downscaler to use from what's installed. sips is macOS built-in. */
export function pickImageTool(available: Record<ImageTool, boolean>): ImageTool | null {
  if (available.sips) return "sips";
  if (available.magick) return "magick";
  if (available.convert) return "convert";
  return null;
}

/**
 * Build the downscale+re-encode command. `maxDim` bounds the long edge; both
 * ImageMagick forms use `>` so a smaller image is never upscaled.
 */
export function downscaleCommand(
  tool: ImageTool,
  src: string,
  dest: string,
  maxDim: number,
  quality: number,
): { cmd: string; args: string[] } {
  switch (tool) {
    case "sips":
      // -Z scales the longest edge and never upscales.
      return {
        cmd: "sips",
        args: ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(maxDim), src, "--out", dest],
      };
    case "magick":
      return { cmd: "magick", args: [src, "-resize", `${maxDim}x${maxDim}>`, "-quality", String(quality), dest] };
    case "convert":
      return { cmd: "convert", args: [src, "-resize", `${maxDim}x${maxDim}>`, "-quality", String(quality), dest] };
  }
}

export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

async function have(cmd: string): Promise<boolean> {
  try {
    // cmd comes from our own fixed ImageTool list — no interpolation risk.
    await exec("/bin/sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

let cachedTool: ImageTool | null | undefined;

async function resolveTool(): Promise<ImageTool | null> {
  if (cachedTool !== undefined) return cachedTool;
  const [sips, magick, convert] = await Promise.all([have("sips"), have("magick"), have("convert")]);
  cachedTool = pickImageTool({ sips, magick, convert });
  return cachedTool;
}

/** Reset the memoized downscaler lookup (tests). */
export function resetImageToolCache(): void {
  cachedTool = undefined;
}

// Claude can run tool calls in parallel, so two conversions can be in flight in
// this same process — pid alone would have them writing the same temp file.
let convSeq = 0;

/**
 * Downscale `filePath` and return it as an MCP image block, or null with a
 * reason when it can't be inlined (no downscaler, still too big, read error).
 * Never throws — a failed image must not fail the tool call that produced it.
 */
export async function imageContent(
  filePath: string,
): Promise<{ block: ImageContentBlock; bytes: number } | { block: null; reason: string }> {
  const tool = await resolveTool();
  if (!tool) return { block: null, reason: "no image downscaler (sips/magick/convert) on this host" };

  let lastBytes = 0;
  const seq = ++convSeq;
  for (const step of LADDER) {
    const dest = join(tmpdir(), `teleclaude-img-${process.pid}-${seq}-${step.maxDim}.jpg`);
    try {
      const { cmd, args } = downscaleCommand(tool, filePath, dest, step.maxDim, step.quality);
      await exec(cmd, args);
      lastBytes = statSync(dest).size;
      if (lastBytes <= MAX_ENCODED_BYTES) {
        const data = readFileSync(dest).toString("base64");
        return { block: { type: "image", data, mimeType: "image/jpeg" }, bytes: lastBytes };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { block: null, reason: `downscale via ${tool} failed: ${msg}` };
    } finally {
      try { unlinkSync(dest); } catch { /* ignore */ }
    }
  }
  return { block: null, reason: `still ${Math.round(lastBytes / 1024)}KB after downscaling (cap ${MAX_ENCODED_BYTES / 1024}KB)` };
}
