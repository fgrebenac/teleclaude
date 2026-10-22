/**
 * Detect whether a Claude Code session id is "live" in some OTHER process on
 * this machine, using the same live-session registry claude-session-registry.ts
 * already reads for /rename verification: ~/.claude/sessions/<pid>.json, one
 * file per running session (terminal or teleclaude-spawned), keyed by pid.
 *
 * This is the two-writer detector for /resume (and, by extension, /handoff):
 * Claude Code does not lock transcripts, so two processes resuming the same
 * session id both append to one JSONL file. A registry entry whose pid is
 * alive AND whose sessionId matches means "already open somewhere" — refuse
 * the resume rather than race it. v1 has no "steal" (kill the other process)
 * option; a hit is a hard refusal.
 */

import { readdirSync } from "fs";
import { readLiveSession, sessionRegistryDir } from "./claude-session-registry.js";

export interface LiveSessionMatch {
  pid: number;
  alive: boolean;
}

export interface FindLiveSessionOptions {
  /** Registry directory override — tests only. */
  baseDir?: string;
  /** Liveness check override — tests only. Default: process.kill(pid, 0). */
  isPidAlive?: (pid: number) => boolean;
}

/**
 * true if a process with this pid exists — including one owned by another
 * user (EPERM), which still counts as "alive" for our purposes. ESRCH means
 * dead. Any other error is treated as "can't tell, assume alive": refusing a
 * resume is the safe default, silently allowing a real collision is not.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Scan the registry for an entry whose sessionId matches. Registry files are
 * tiny and few (one per concurrently running Claude Code session on the whole
 * machine), so a full directory scan per call is cheap — no cache needed.
 * Never throws: a missing directory, a non-`<pid>.json` filename, or an
 * unparseable entry (readLiveSession's own contract) are all skipped.
 *
 * Scans EVERY matching entry rather than stopping at the first — a stale
 * registry file for a dead pid can linger alongside a fresh one for the same
 * session id (readdirSync order is not defined to favor either), and
 * returning the stale/dead one first would wrongly report "not live" when a
 * DIFFERENT process actually holds it. An alive match always wins when one
 * exists; the fail-closed direction (refusing a resume) is the one that
 * matters here.
 */
export function findLiveSession(sessionId: string, opts: FindLiveSessionOptions = {}): LiveSessionMatch | null {
  const baseDir = opts.baseDir ?? sessionRegistryDir();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  let files: string[];
  try {
    files = readdirSync(baseDir);
  } catch {
    return null;
  }
  let firstDead: LiveSessionMatch | null = null;
  for (const file of files) {
    const m = /^(\d+)\.json$/.exec(file);
    if (!m) continue;
    const pid = Number(m[1]);
    const entry = readLiveSession(pid, baseDir);
    if (entry?.sessionId !== sessionId) continue;
    if (isPidAlive(pid)) return { pid, alive: true };
    if (!firstDead) firstDead = { pid, alive: false };
  }
  return firstDead;
}

/**
 * Convenience for /sessions' 🔺 marker: true only when the session is alive in
 * a DIFFERENT process than the one asking (ownPid) — a topic's own current
 * process holding its own session id is not "elsewhere".
 */
export function isSessionLiveElsewhere(
  sessionId: string,
  ownPid: number | undefined,
  opts: FindLiveSessionOptions = {},
): boolean {
  const match = findLiveSession(sessionId, opts);
  return !!match && match.alive && match.pid !== ownPid;
}

export interface ResumeGuardDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Should a resume of this session id proceed? Refuses only when the registry
 * shows it alive in a pid that is NOT this topic's own current process — v1
 * refuses outright (no "steal"): the point is to never let two Claude Code
 * processes append to the same transcript, and silently killing the other
 * side is not something to do without its consent.
 */
export function resumeGuardDecision(live: LiveSessionMatch | null, ownPid: number | undefined): ResumeGuardDecision {
  if (!live || !live.alive || live.pid === ownPid) return { allow: true };
  return {
    allow: false,
    reason: `session is open in another Claude process (pid ${live.pid}) — close it there, or use /handoff to move it here deliberately (steal not yet supported)`,
  };
}
