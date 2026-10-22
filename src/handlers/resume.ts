import { existsSync, realpathSync } from "fs";
import { relative } from "path";
import { resolveSessionHome } from "../sessions.js";
import { resumeCwdDecision } from "../resume-cwd.js";
import { updateTopicSession, getTopicSession, spawnSettingsFor } from "../session-state.js";
import { findLiveSession, resumeGuardDecision } from "../live-sessions.js";
import { log } from "../log.js";
import type { ProcessManager } from "../processes.js";

export type ResumeOutcome =
  | { ok: true; subpath?: string }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "live-elsewhere"; pid: number; detail: string }
  | { ok: false; reason: "cwd-missing"; message: string };

/**
 * Validate that a session exists (searching every worktree/subfolder home,
 * not just the project root — see sessions.ts's sessionHomes) AND isn't
 * already open in another Claude Code process on this machine
 * (live-sessions.ts — Claude Code doesn't lock transcripts, so two processes
 * resuming the same id both append to one JSONL file), then kill the current
 * process and respawn resuming it at the session's OWN cwd.
 *
 * v1 refuses outright on a live-elsewhere hit; there is no "steal" (kill the
 * other process) option yet.
 *
 * Also refuses (rather than silently resuming at the wrong cwd, or at the
 * project root when that's not where the session's history lives) when the
 * session's home is a worktree/subfolder that no longer exists on disk — see
 * resumeCwdDecision.
 */
export async function resumeSession(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
  projectPath: string,
  sessionId: string,
): Promise<ResumeOutcome> {
  const home = resolveSessionHome(projectPath, sessionId);
  if (!home) {
    log(`[resume] topic=${topicId} session=${sessionId.slice(0, 8)} not found`);
    return { ok: false, reason: "not-found" };
  }

  // Read BEFORE any kill/spawn — kill() deletes the process map entry
  // synchronously, after which getPid() would return undefined.
  const ownPid = processManager.getPid(chatId, topicId);
  const live = findLiveSession(sessionId);
  const liveDecision = resumeGuardDecision(live, ownPid);
  if (!liveDecision.allow) {
    log(`[resume] topic=${topicId} session=${sessionId.slice(0, 8)} refused — ${liveDecision.reason}`);
    return { ok: false, reason: "live-elsewhere", pid: live!.pid, detail: liveDecision.reason! };
  }

  let rootReal = projectPath;
  try { rootReal = realpathSync(projectPath); } catch { /* use as-is */ }
  const cwdExists = home.cwd !== rootReal && existsSync(home.cwd);
  const cwdDecision = resumeCwdDecision({ home, rootReal, cwdExists });
  if (!cwdDecision.ok) {
    log(`[resume] topic=${topicId} session=${sessionId.slice(0, 8)} refused: ${cwdDecision.reason}`);
    return { ok: false, reason: "cwd-missing", message: cwdDecision.reason };
  }

  log(`[resume] topic=${topicId} session=${sessionId.slice(0, 8)} cwd=${cwdDecision.cwd ?? "(root)"} — killing old, spawning new`);
  processManager.kill(chatId, topicId);
  updateTopicSession(chatId, topicId, { sessionId, projectPath, sessionCwd: cwdDecision.cwd });
  processManager.spawn(chatId, topicId, projectPath, spawnSettingsFor(getTopicSession(chatId, topicId), { sessionId, cwd: cwdDecision.cwd }));

  return { ok: true, subpath: cwdDecision.cwd ? relative(rootReal, cwdDecision.cwd) : undefined };
}
