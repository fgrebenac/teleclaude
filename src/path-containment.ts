import { realpathSync, statSync } from "fs";
import { isAbsolute, resolve, sep } from "path";

/**
 * Telegram's Bot API caps document uploads at 50MB; refusing earlier also
 * bounds the readFileSync heap spike inside the channel server.
 */
export const MAX_SEND_FILE_BYTES = 50 * 1024 * 1024;

export type ContainmentResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Resolve a caller-supplied path and allow it only if it lives inside `root`.
 *
 * This is the entire security boundary for send_file: the tool is pre-approved
 * via --allowedTools, so in auto mode the permission classifier never vets it —
 * without this check a prompt-injected repo could read ~/.ssh keys or the MCP
 * config (which holds the bot token) and post them to the Telegram topic.
 *
 * realpathSync on BOTH sides: the project dir itself can be a symlink
 * (CLAUDE.md "Symlink resolution"), and a symlink *inside* the root pointing
 * outside must resolve to its real target and be rejected.
 */
export function resolveWithinRoot(
  root: string,
  requested: string,
  maxBytes: number = MAX_SEND_FILE_BYTES,
): ContainmentResult {
  if (!root) {
    return { ok: false, reason: "no project root configured — refusing to read any file" };
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, reason: `project root not accessible: ${root}` };
  }
  const candidate = isAbsolute(requested) ? requested : resolve(rootReal, requested);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, reason: `file not found: ${requested}` };
  }
  // Exact match or a child path — `rootReal + sep` so /a/b-evil is not "inside" /a/b.
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return {
      ok: false,
      reason: `${requested} is outside the project directory — send_file only sends files under ${rootReal}`,
    };
  }
  const st = statSync(real);
  if (!st.isFile()) {
    return { ok: false, reason: `not a regular file: ${requested}` };
  }
  if (st.size > maxBytes) {
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    const capMb = Math.round(maxBytes / (1024 * 1024));
    return { ok: false, reason: `file is ${mb}MB — over the ${capMb}MB send limit` };
  }
  return { ok: true, path: real, bytes: st.size };
}

/**
 * Whether `child` is `root` itself or lives under it. Realpath-resolves both
 * sides so a symlinked project root or a canonicalized transcript `cwd` still
 * compares correctly — but if EITHER side no longer exists on disk (a deleted
 * git worktree is the motivating case: Claude Code recorded its cwd while it
 * existed, and by the time a session list is rendered it may not), falls back
 * to the raw string for that side rather than throwing. That degrade is safe
 * because both sides are already-canonical absolute paths by the time they
 * reach here (a project root teleclaude manages, or a `cwd` field Claude Code
 * itself wrote into a transcript) — never caller-supplied relative input.
 *
 * `realpath` is injectable so tests can exercise the degrade path without
 * touching the filesystem.
 */
export function isPathInside(
  root: string,
  child: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  let rootReal: string;
  try {
    rootReal = realpath(root);
  } catch {
    rootReal = root;
  }
  let childReal: string;
  try {
    childReal = realpath(child);
  } catch {
    childReal = child;
  }
  return childReal === rootReal || childReal.startsWith(rootReal + sep);
}
