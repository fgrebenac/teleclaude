import type { Bot } from "grammy";
import type { ProcessManager } from "./processes.js";

export type RequestCancelResult = "sent" | "not-running";

/**
 * Ask Claude Code to interrupt whatever a topic is currently doing — shared
 * by the `/cancel` command and the "⏹ Cancel turn" alert button.
 *
 * Writes Ctrl+C into the PTY (ProcessManager.interruptTurn) and tells the
 * user with modest, honest wording — never a confident "cancelled", since no
 * hook event can safely confirm the interrupt actually stopped the right
 * thing (Claude Code's Stop hook fires many times per delivered message with
 * no correlator id — confirmed live: a successful Ctrl+C interrupt of an
 * in-flight tool call produces zero `tool_use`/`tool_use_post`/`done`/`error`
 * callbacks, so there is nothing here to key a follow-up message off).
 *
 * Deliberately does NOT follow up with a "still running, force stop?" nudge
 * after a grace period — a live test caught this firing on a cancel that had
 * actually worked, because a successful Ctrl+C is *supposed* to leave the
 * process running (that's the entire point of a soft interrupt over `/stop`),
 * so "still running" is nearly always true regardless of outcome and isn't
 * evidence of anything. A genuinely stuck session is already caught by the
 * existing stall/watchdog alerts (`turn-warnings.ts`) on their own schedule,
 * which offer Force Stop the same way any other stuck session would.
 *
 * Also asks the topic's channel server to resolve any pending ask_user
 * question as cancelled (it would otherwise wait out its own 5-minute
 * timeout for an answer nobody will give).
 */
export async function requestCancel(
  bot: Bot,
  pm: ProcessManager,
  chatId: number,
  topicId: number,
): Promise<RequestCancelResult> {
  const result = pm.interruptTurn(chatId, topicId);
  if (result === "not-running") return "not-running";

  await bot.api.sendMessage(chatId, "⏳ Interrupt sent…", { message_thread_id: topicId }).catch(() => {});

  const port = pm.getPort(chatId, topicId);
  if (port) {
    fetch(`http://127.0.0.1:${port}/cancel-ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-teleclaude-token": pm.getSpawnToken(chatId, topicId) ?? "" },
      body: "{}",
    }).catch(() => {});
  }

  return "sent";
}

/**
 * Validate a Cancel-turn / Force-stop button tap against the topic's current
 * per-render turn token (ProcessManager.beginTurn). A tokened button matches
 * only the exact live token; a bare (token-less) button — rendered when no
 * turn had begun — matches only while that is still true. Either way, a stale
 * alert whose retire-edit failed can't be tapped into interrupting (or
 * force-killing) unrelated new work.
 */
export function turnTokenMatches(
  current: { seq: number; nonce: string } | undefined,
  seqStr: string | undefined,
  nonce: string | undefined,
): boolean {
  if (!current) return seqStr === undefined && nonce === undefined;
  return String(current.seq) === seqStr && current.nonce === nonce;
}
