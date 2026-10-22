/**
 * Claude Code's live-session registry: `~/.claude/sessions/<pid>.json`, one file
 * per *running* session, rewritten as the session's state changes.
 *
 * Confirmed by inspection on 2.1.234 — teleclaude-spawned sessions are in there
 * alongside terminal ones, keyed by the PTY child's pid, e.g.
 *
 *   {"pid":63493,"sessionId":"35133a33-…","cwd":"/Users/…/Todo",
 *    "name":"todo-c6","nameSource":"derived","status":"idle", …}
 *
 * This is not part of any documented settings schema, so treat it as an
 * implementation detail that may change: every read here is best-effort and a
 * missing or unparseable file means "unknown", never an error. What it buys is
 * a way to *verify* a rename typed into a PTY instead of hoping — see
 * `session-name.ts`.
 *
 * `nameSource` is deliberately not relied on: it reads "derived" for a
 * Claude-Code-generated name and was observed absent after a user rename, so
 * the name itself is the signal.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface LiveSessionInfo {
  pid: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  nameSource?: string;
  status?: string;
}

export function sessionRegistryDir(): string {
  return join(homedir(), ".claude", "sessions");
}

/** Read one live session's registry entry, or null if there isn't a usable one. */
export function readLiveSession(pid: number, baseDir = sessionRegistryDir()): LiveSessionInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(join(baseDir, `${pid}.json`), "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as LiveSessionInfo;
  } catch {
    return null;
  }
}

/** The session's current display name, or undefined if unknown. */
export function readLiveSessionName(pid: number, baseDir = sessionRegistryDir()): string | undefined {
  const name = readLiveSession(pid, baseDir)?.name;
  return typeof name === "string" && name ? name : undefined;
}

/**
 * Poll the registry until `isDone` accepts the name, or the timeout expires.
 * Returns the last name read either way (undefined if never readable), so the
 * caller can distinguish "changed to X" from "still what it was".
 *
 * Bounded on purpose: this runs while a user waits on a Telegram reply, and the
 * write it's waiting for landed within ~500ms in testing.
 */
export async function pollSessionName(
  pid: number,
  isDone: (name: string | undefined) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; baseDir?: string } = {},
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = readLiveSessionName(pid, opts.baseDir);
  while (!isDone(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = readLiveSessionName(pid, opts.baseDir);
  }
  return last;
}
