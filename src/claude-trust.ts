import { readFileSync, existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeJsonAtomic } from "./fs-util.js";
import { log } from "./log.js";

function defaultClaudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

/**
 * Pre-accept Claude Code's one-time workspace-trust dialog for a freshly
 * created project, by setting `projects[<realpath>].hasTrustDialogAccepted`
 * directly in Claude Code's own global config (`~/.claude.json`) — an
 * undocumented but binary-confirmed mechanism: the CLI's own "workspace not
 * trusted" error message names this exact field as the alternative to
 * accepting the dialog interactively once. This is the only startup dialog
 * with a real bypass; the "development channels" warning has none and still
 * needs the PTY-scan fallback in `processes.ts`.
 *
 * Best-effort and narrowly scoped: `~/.claude.json` is Claude Code's own
 * shared config across every project on the machine (potentially dozens),
 * actively read/written by every concurrently running Claude Code process —
 * not just teleclaude's. This reads, sets exactly one field for exactly one
 * project path, and writes back immediately, keeping the race window with a
 * concurrent write from another session as small as possible. A lost race
 * only means some OTHER project's entry reverts to whatever this read saw —
 * recoverable (Claude Code keeps rotating backups in `~/.claude/backups/`,
 * and the worst case is a dialog needing re-acceptance), never data loss.
 * Never throws — a failure here must not block project creation.
 */
export function preTrustWorkspace(projectPath: string, claudeJsonPath: string = defaultClaudeJsonPath()): void {
  try {
    if (!existsSync(claudeJsonPath)) return; // no global config yet — nothing to pre-seed safely
    const realPath = realpathSync(projectPath);
    const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    if (!parsed.projects || typeof parsed.projects !== "object") parsed.projects = {};
    const existing = parsed.projects[realPath];
    if (existing?.hasTrustDialogAccepted === true) return; // already trusted
    parsed.projects[realPath] = { ...existing, hasTrustDialogAccepted: true };
    writeJsonAtomic(claudeJsonPath, parsed);
    log(`[trust] pre-accepted workspace trust for ${realPath}`);
  } catch (err) {
    log(`[trust] pre-trust failed for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
