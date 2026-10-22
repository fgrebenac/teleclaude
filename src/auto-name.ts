/**
 * Give an unnamed session a real name after its first finished turn.
 *
 * Claude Code only generates a descriptive title (`ai-title`) for sessions it
 * sees typed prompts in — a channel-driven session never gets one (observed on
 * 2.1.308), so a Telegram session stays `<dir>-<2hex>` forever, and `/sessions`
 * and the terminal `/resume` picker have nothing better to show. A bare
 * `/rename` asks Claude Code to name the session from the conversation; it's
 * the same command `/rename` (no argument) already sends, just fired once on
 * its own.
 *
 * The name is Claude Code's, not ours: it lands in the transcript
 * (`custom-title`/`agent-name`, read by `/sessions`) and is restored by Claude
 * Code itself on resume (verified live: `nameSource: "user"` after
 * `--resume`). So it is deliberately NOT persisted to sessions.json — a
 * persisted name is re-applied with `-n` at every spawn, which would stamp it
 * onto a different session the topic later resumes.
 *
 * Typing into the PTY is only safe at an idle prompt: mid-turn, the text would
 * queue as a prompt, and with a permission dialog open the Enter would answer
 * it. So the gate is Claude Code's own `status: "idle"` from the live-session
 * registry, read immediately before typing.
 */

import { log } from "./log.js";
import { readLiveSession, type LiveSessionInfo } from "./claude-session-registry.js";
import { requestRename } from "./rename.js";
import type { ProcessManager } from "./processes.js";

export interface AutoNameInputs {
  /** `defaults.autoNameSessions` — unset means on. */
  enabled: boolean;
  /** A name the user chose (`/rename <name>`, `/new <name>`) for this topic. */
  persistedName?: string;
  /** The session's live-registry entry, read just now. */
  live: LiveSessionInfo | null;
  /** The pid this topic last attempted an auto-name for. */
  attemptedPid?: number;
}

export type AutoNameDecision =
  | { go: true }
  | { go: false; reason: "disabled" | "named" | "no-registry" | "attempted" | "busy" };

export function autoNameDecision(i: AutoNameInputs): AutoNameDecision {
  if (!i.enabled) return { go: false, reason: "disabled" };
  if (i.persistedName) return { go: false, reason: "named" };
  if (!i.live) return { go: false, reason: "no-registry" };
  // One try per process: a rename that didn't land isn't retried every turn.
  if (i.attemptedPid === i.live.pid) return { go: false, reason: "attempted" };
  // Anything but Claude Code's own placeholder is a name someone chose — a
  // terminal /rename, or one restored on resume.
  if (i.live.nameSource !== "derived") return { go: false, reason: "named" };
  if (i.live.status !== "idle") return { go: false, reason: "busy" };
  return { go: true };
}

export interface AutoNameState {
  attemptedPid?: number;
}

export interface MaybeAutoNameOptions {
  enabled: boolean;
  persistedName?: string;
  /** Registry directory override — tests only. */
  baseDir?: string;
  /** Read-back budget. Generating a name is a model call (~1.6s observed). */
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Auto-name the topic's session if it qualifies. Returns the new name, or
 * undefined when nothing was (confirmably) renamed. Never throws.
 */
export async function maybeAutoName(
  pm: ProcessManager,
  chatId: number,
  topicId: number,
  state: AutoNameState,
  opts: MaybeAutoNameOptions,
): Promise<string | undefined> {
  try {
    const pid = pm.getPid(chatId, topicId);
    const live = pid ? readLiveSession(pid, opts.baseDir) : null;
    const decision = autoNameDecision({
      enabled: opts.enabled,
      persistedName: opts.persistedName,
      live,
      attemptedPid: state.attemptedPid,
    });
    if (!decision.go) return undefined;

    state.attemptedPid = live!.pid;
    const result = await requestRename(pm, chatId, topicId, undefined, {
      timeoutMs: opts.timeoutMs ?? 15_000,
      intervalMs: opts.intervalMs,
      baseDir: opts.baseDir,
    });
    log(`[auto-name] topic=${topicId} pid=${live!.pid} → ${result.status}${result.name ? ` "${result.name}"` : ""}`);
    return result.status === "confirmed" ? result.name : undefined;
  } catch (err) {
    log(`[auto-name] topic=${topicId} failed: ${err}`);
    return undefined;
  }
}
