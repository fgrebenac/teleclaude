/**
 * `/rename` for a live session — type Claude Code's own slash command into the
 * PTY, then read the result back out of its live-session registry.
 *
 * Why not a teleclaude-local label: the name is wanted in the places Claude
 * Code already shows one (prompt box, `/resume` picker, terminal title) and,
 * more usefully, `/rename` makes Claude *itself* aware of the name via a system
 * reminder ("The user named this session …"), which a label in sessions.json
 * could never do. So this drives the real thing and mirrors the result into
 * sessions.json only so a respawn can re-apply it with `claude -n`.
 *
 * Why this one *can* claim success where `/cancel` deliberately can't: the
 * rename is observable. Claude Code rewrites `~/.claude/sessions/<pid>.json`
 * with the new name (~500ms in testing), so instead of "interrupt sent…" this
 * reports the session's actual name — including the case where Claude Code
 * picked a variant because another live session already held the requested one.
 */

import { escapeHtml } from "./telegram-format.js";
import { log } from "./log.js";
import { readLiveSessionName, pollSessionName } from "./claude-session-registry.js";
import { resolveRenameOutcome, type RenameOutcome } from "./session-name.js";
import type { ProcessManager } from "./processes.js";

export type RequestRenameResult = RenameOutcome | { status: "not-running"; name?: undefined };

export interface RequestRenameOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Registry directory override — tests only. */
  baseDir?: string;
}

/**
 * Ask a running session to rename itself. `requested === undefined` asks Claude
 * Code to generate a name from the conversation (its own bare-`/rename`
 * behaviour), in which case the generated name is read back from the registry.
 */
export async function requestRename(
  pm: ProcessManager,
  chatId: number,
  topicId: number,
  requested: string | undefined,
  opts: RequestRenameOptions = {},
): Promise<RequestRenameResult> {
  if (!pm.isRunning(chatId, topicId)) return { status: "not-running" };

  const pid = pm.getPid(chatId, topicId);
  const before = pid ? readLiveSessionName(pid, opts.baseDir) : undefined;

  if (pm.sendRenameCommand(chatId, topicId, requested) === "not-running") {
    return { status: "not-running" };
  }

  // No pid means no way to verify — say so rather than assuming it worked.
  if (!pid) return { status: "unconfirmed" };

  // Stop as soon as the registry shows the requested name, or any change from
  // what was there before (the "another live session holds that name" case
  // lands on a variant, which would otherwise cost the full timeout).
  const after = await pollSessionName(
    pid,
    (n) => n !== undefined && (n === requested || n !== before),
    opts,
  );

  const outcome = resolveRenameOutcome(requested, before, after);
  log(`[rename] topic=${topicId} requested=${requested ?? "(auto)"} before=${before ?? "?"} after=${after ?? "?"} → ${outcome.status}`);
  return outcome;
}

/**
 * What to tell the user. The name is user-supplied text going into a
 * `parse_mode: "HTML"` message, so it is escaped here — an unescaped `<` or `&`
 * makes Telegram reject the send outright, and the notice never arrives.
 */
export function renameNotice(result: RequestRenameResult, requested: string | undefined): string {
  switch (result.status) {
    case "confirmed":
      return `✏️ Session renamed to <b>${escapeHtml(result.name ?? requested ?? "")}</b>`;
    case "adjusted":
      return [
        `✏️ Session named <b>${escapeHtml(result.name ?? "")}</b>`,
        `<i>Claude Code adjusted "${escapeHtml(requested ?? "")}" — another live session on this machine already holds that name.</i>`,
      ].join("\n");
    case "unconfirmed":
      return requested
        ? `⏳ Sent <code>/rename</code> to the session — couldn't confirm the new name. Saved <b>${escapeHtml(requested)}</b> for this topic; /status will show what it ends up as.`
        : `⏳ Sent <code>/rename</code> to the session — couldn't read back the name it picked. Try /status in a moment.`;
    case "not-running":
      return requested
        ? `✏️ No session running — saved <b>${escapeHtml(requested)}</b>. The next session for this topic starts with that name.`
        : `No session running. Use <code>/rename &lt;name&gt;</code> to name the next one.`;
  }
}
