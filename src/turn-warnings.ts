import type { Bot } from "grammy";
import { topicRuntime, peekTopicRuntime } from "./topic-runtime.js";

export type WarningSeverity = "soft" | "hard";

/** Forget any tracked warning for a topic — called on turn end (reply/done/error)
 *  and when /cancel retires the alert. Process death clears it via
 *  TopicRuntime.dispose() — no caller needs to pair it with a kill. */
export function clearTurnWarning(chatId: number, topicId: number): void {
  const rt = peekTopicRuntime(chatId, topicId);
  if (rt) rt.warning = undefined;
}

/**
 * Show or escalate the long-running-task warning for a topic. Severity is
 * monotonic — a soft warning is dropped if a hard alert is already showing for
 * this turn, and a hard alert always upgrades an existing soft message in
 * place rather than sending a second one, so a turn that's both had one tool
 * run long AND the turn overall gone quiet doesn't produce two separate
 * warnings competing for the user's attention.
 */
export async function showTurnWarning(
  bot: Bot,
  chatId: number,
  topicId: number,
  severity: WarningSeverity,
  text: string,
  buttons?: { text: string; callback_data: string }[][],
): Promise<void> {
  const rt = topicRuntime(chatId, topicId);
  const existing = rt.warning;
  if (existing?.severity === "hard" && severity === "soft") return; // monotonic

  const reply_markup = { inline_keyboard: buttons ?? [] };
  if (existing) {
    const edited = await bot.api.editMessageText(chatId, existing.messageId, text, { reply_markup })
      .then(() => true)
      .catch(() => false);
    if (edited) {
      rt.warning = { messageId: existing.messageId, severity };
      return;
    }
    // The edit failed — most likely the tracked message is gone (deleted,
    // edit window expired). Hard escalations are one-shot, so returning here
    // would swallow the only Cancel/Force-Stop alert the user will ever get
    // for this turn. Forget the phantom id and fall through to a fresh send
    // NOW, not on a future call that may never come.
    rt.warning = undefined;
  }
  const sent = await bot.api.sendMessage(chatId, text, { message_thread_id: topicId, reply_markup }).catch(() => undefined);
  if (sent) rt.warning = { messageId: sent.message_id, severity };
}
