/**
 * Session display names — teleclaude's side of Claude Code's own naming.
 *
 * Claude Code names every session by itself (`nameSource: "derived"`, e.g.
 * `todo-c6`) and offers two ways to override that: the `-n/--name` flag at
 * launch and the `/rename` slash command on a live session. teleclaude uses
 * both rather than inventing a parallel label, so a name set from Telegram is
 * the same name the terminal `/resume` picker, the prompt box and the terminal
 * title show — and so Claude itself learns it (a rename injects a system
 * reminder telling the model the user named the session, which is half the
 * point of naming one from a phone).
 *
 * A name reaches a *live* session by being typed into the PTY, which is why
 * sanitizing matters here: a newline in the string would submit `/rename`
 * early and turn the remainder into an ordinary prompt for Claude to answer.
 * Control characters are stripped for that reason, not for tidiness.
 */

/** Longest name we'll pass on. Claude Code itself only trims and strips
 *  invisible characters, so this cap is ours — a name is UI, and a 4,000-char
 *  one would just be a broken prompt box and an unreadable /status line. */
export const MAX_SESSION_NAME_LENGTH = 64;

/**
 * Normalize a user-supplied name into something safe to type into a PTY, or
 * undefined if nothing usable is left.
 *
 * Note the deliberate distinction the callers rely on: `undefined` in means
 * "no name given" (→ let Claude Code generate one), while a non-empty string
 * that sanitizes to `undefined` means "you typed something unusable" and is
 * worth an error rather than a silent auto-generate.
 */
export function sanitizeSessionName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw
    // Newlines, tabs, escape bytes — anything that would be interpreted as
    // input rather than text once written to the PTY.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_SESSION_NAME_LENGTH).trim();
}

/**
 * The command text to type into the PTY — WITHOUT the submitting carriage
 * return, which `sendRenameCommand` writes separately after
 * `RENAME_SUBMIT_DELAY_MS`. Bare `/rename` (no argument) is Claude Code's
 * "name it from the conversation" path.
 */
export function renameCommandText(name?: string): string {
  return name ? `/rename ${name}` : "/rename";
}

/**
 * Gap between typing the command and pressing Enter. One write with a trailing
 * `\r` worked on 2.1.234, but on 2.1.308 a long enough single write is taken
 * as a paste: the text lands in the prompt box and the `\r` is dropped
 * ("Removed 2 invisible characters · review and press Enter to send"). Verified
 * live: a 64-char `/rename …` in one write never submitted; the same text
 * followed by a separate `\r` 150ms later renamed the session in ~400ms.
 */
export const RENAME_SUBMIT_DELAY_MS = 150;

export type RenameStatus =
  /** The session now carries the name we asked for (or, for a bare /rename, a
   *  generated one we can read back). */
  | "confirmed"
  /** Renamed, but not to what we asked — Claude Code refuses to hand two live
   *  sessions the same name and picks a variant. Report what it actually is. */
  | "adjusted"
  /** The registry never changed. The rename may still land later; we simply
   *  can't claim it did. */
  | "unconfirmed";

export interface RenameOutcome {
  status: RenameStatus;
  /** The session's actual name, when we could read one back. */
  name?: string;
}

/**
 * Decide what to tell the user, from the name in Claude Code's live-session
 * registry before and after the keystrokes.
 *
 * Unlike `/cancel` — where no observable signal distinguishes a successful
 * interrupt from a no-op, so teleclaude never claims success — a rename *is*
 * observable: Claude Code rewrites `~/.claude/sessions/<pid>.json`. So this
 * reports the real name, including the case where it differs from the request.
 */
export function resolveRenameOutcome(
  requested: string | undefined,
  before: string | undefined,
  after: string | undefined,
): RenameOutcome {
  if (after === undefined) return { status: "unconfirmed" };
  if (requested !== undefined && after === requested) return { status: "confirmed", name: after };
  if (after !== before) {
    // Changed, but not into the requested name. For a bare /rename that *is*
    // the success case (we never named it, Claude Code did).
    return requested === undefined
      ? { status: "confirmed", name: after }
      : { status: "adjusted", name: after };
  }
  return { status: "unconfirmed", name: after };
}
