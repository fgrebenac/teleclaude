import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { escapeHtml } from "./telegram-format.js";
import { getTopicSession } from "./session-state.js";

const execFileP = promisify(execFile);

/**
 * Uncommitted-work inspection for a project directory. All git invocations use
 * execFile with an argument array — the path and any git output are
 * user/repo-controlled and must never be interpolated into a shell string.
 */

/** Bound how much diff output is pulled into memory. Past this, `truncated` is set.
 *  Sized to track Telegram's 50MB document cap with headroom for multipart/upload
 *  overhead, so a large-but-deliverable patch still gets attached rather than dropped. */
export const MAX_PATCH_BYTES = 45 * 1024 * 1024;

/** Don't let a pathological repo (huge history, hung index lock) hang a turn. */
const GIT_TIMEOUT_MS = 15_000;

/** Keep the HTML stat block comfortably inside Telegram's 4096-char limit. */
const STAT_CLIP = 3200;
const UNTRACKED_LIST_MAX = 15;

export interface GitDiffResult {
  isRepo: boolean;
  /** Anything to review: staged/unstaged changes vs HEAD, or untracked files. */
  hasChanges: boolean;
  /** `git diff HEAD --stat` output, trimmed ("" when clean or truncated-away). */
  stat: string;
  /** Full patch text ("" when clean, or when it exceeded MAX_PATCH_BYTES). */
  patch: string;
  untracked: string[];
  /** The patch (and possibly the stat) exceeded MAX_PATCH_BYTES. */
  truncated: boolean;
  /** Stable fingerprint of the dirty state (from `git status --porcelain`);
   *  lets the turn-end review prompt skip re-nagging for an unchanged tree. */
  signature: string;
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", projectPath, ...args], {
    maxBuffer: MAX_PATCH_BYTES,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

/** `git status --porcelain`, or isRepo=false when the directory isn't a work tree. */
export async function gitStatusPorcelain(projectPath: string): Promise<{ isRepo: boolean; porcelain: string }> {
  try {
    const porcelain = await git(projectPath, ["status", "--porcelain"]);
    return { isRepo: true, porcelain };
  } catch {
    return { isRepo: false, porcelain: "" };
  }
}

/**
 * Collect everything `/diff` shows. Diffs against HEAD (covers staged AND
 * unstaged); a repo with no commits yet has no HEAD, so it falls back to the
 * worktree-vs-index diff (which is empty there — untracked files carry it).
 */
export async function collectGitDiff(projectPath: string): Promise<GitDiffResult> {
  const status = await gitStatusPorcelain(projectPath);
  if (!status.isRepo) {
    return { isRepo: false, hasChanges: false, stat: "", patch: "", untracked: [], truncated: false, signature: "" };
  }
  const signature = dirtySignature(status.porcelain);
  const untracked = status.porcelain
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim());

  let hasHead = true;
  try {
    await git(projectPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  const base = hasHead ? ["HEAD"] : [];

  let stat = "";
  let patch = "";
  let truncated = false;
  try {
    stat = (await git(projectPath, ["diff", ...base, "--stat"])).trimEnd();
    patch = await git(projectPath, ["diff", ...base]);
  } catch {
    // execFile throws when maxBuffer is exceeded — keep whatever landed and say so.
    truncated = true;
  }

  return {
    isRepo: true,
    // `truncated` counts as changed: a diff so large it overflowed the buffer is
    // never a clean tree, and reporting "working tree clean" there would be an
    // actively wrong answer for a review-before-merge command.
    hasChanges: Boolean(stat) || untracked.length > 0 || truncated,
    signature,
    stat,
    patch,
    untracked,
    truncated,
  };
}

/** HTML summary message for the topic. Everything from git goes through escapeHtml. */
export function formatDiffHeader(r: Pick<GitDiffResult, "stat" | "untracked" | "truncated">): string {
  const lines: string[] = ["<b>Uncommitted changes</b>"];
  if (r.stat) {
    const stat = r.stat.length > STAT_CLIP ? `${r.stat.slice(0, STAT_CLIP)}\n… [clipped]` : r.stat;
    lines.push(`<pre>${escapeHtml(stat)}</pre>`);
  }
  if (r.untracked.length) {
    const shown = r.untracked.slice(0, UNTRACKED_LIST_MAX);
    lines.push(`Untracked (${r.untracked.length}):`);
    lines.push(...shown.map((f) => `• <code>${escapeHtml(f)}</code>`));
    if (r.untracked.length > shown.length) lines.push(`…and ${r.untracked.length - shown.length} more`);
  }
  if (r.truncated) lines.push("<i>Patch too large to attach — showing the summary only.</i>");
  return lines.join("\n");
}

/**
 * Stable fingerprint of a dirty working tree, from `git status --porcelain`
 * output. Order-insensitive so an unchanged tree never re-prompts just because
 * git listed files in a different order.
 */
export function dirtySignature(porcelain: string): string {
  return porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * Directory /diff and /review should inspect: a resumed session's own
 * working directory (`sessionCwd`) when it's set and still exists on disk,
 * falling back to the project root otherwise. A git worktree has its own
 * working tree — diffing the root would silently miss it entirely, and a
 * deleted worktree's stale cwd must fall back rather than diff a directory
 * that no longer exists.
 */
export function diffCwdFor(chatId: number, topicId: number, projectPath: string): string {
  const cwd = getTopicSession(chatId, topicId)?.sessionCwd;
  return cwd && existsSync(cwd) ? cwd : projectPath;
}

export function reviewPromptText(fileCount: number): string {
  return `📝 Turn finished with ${fileCount} uncommitted file${fileCount === 1 ? " " : "s"} in the working tree.`;
}
