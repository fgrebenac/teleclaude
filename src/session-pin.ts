/**
 * Pinned session-name message: one small bot message per topic
 * ("📌 <session name> · <model>"), pinned once and then *edited in place* as
 * the session changes, so the topic's pinned bar always names the session the
 * topic is talking to. Editing instead of re-pinning means the one-time
 * "pinned a message" service message happens only when the pin is first
 * created (daemon.ts deletes even that one — see the pre-auth handler there).
 *
 * The name is read from Claude Code's own live-session registry when a pid is
 * available (the same `~/.claude/sessions/<pid>.json` that /rename verification
 * uses), so even a never-renamed session shows its derived name; the persisted
 * `SessionEntry.name` is the fallback for a topic whose process is gone.
 *
 * Default ON per topic (`pinSession` absent = enabled), toggled by /pin.
 * Everything here is best-effort: a bot without the "Pin messages" admin right
 * gets one notice per topic per daemon lifetime and otherwise stays silent.
 */

import { log } from "./log.js";
import { topicKey } from "./bot.js";
import { readLiveSessionName } from "./claude-session-registry.js";
import { getTopicSession, updateTopicSession } from "./session-state.js";

/** Structural subset of grammY's Api that pin maintenance needs. */
export interface PinApi {
  sendMessage(
    chat_id: number,
    text: string,
    other?: { message_thread_id?: number; disable_notification?: boolean },
  ): Promise<{ message_id: number }>;
  editMessageText(chat_id: number, message_id: number, text: string): Promise<unknown>;
  pinChatMessage(chat_id: number, message_id: number, other?: { disable_notification?: boolean }): Promise<unknown>;
  unpinChatMessage(chat_id: number, message_id?: number): Promise<unknown>;
  deleteMessage(chat_id: number, message_id: number): Promise<unknown>;
}

export function pinText(name: string, model?: string): string {
  return `📌 ${name}${model ? ` · ${model}` : ""}`;
}

/** Topics already told "I can't pin here" — once per daemon lifetime is enough. */
const pinFailureNotified = new Set<string>();

/** Test hook: forget which topics were notified about missing pin rights. */
export function resetPinNoticeMemory(): void {
  pinFailureNotified.clear();
}

function errText(err: unknown): string {
  const e = err as { description?: unknown; message?: unknown } | undefined;
  return String(e?.description ?? e?.message ?? err);
}

export interface MaintainPinOpts {
  /** The topic's live PTY child pid, when running — unlocks the registry name. */
  pid?: number;
  /** Test override for the live-session registry directory. */
  registryBaseDir?: string;
}

/**
 * Bring the topic's pinned message in line with its current session. No-op when
 * the pin is toggled off, no name is known, or the pin already shows this text.
 * Never throws (Telegram/API failures are logged and swallowed) — but callers
 * should still `.catch(() => {})` in case state persistence itself fails.
 */
export async function maintainSessionPin(
  api: PinApi,
  chatId: number,
  topicId: number,
  opts: MaintainPinOpts = {},
): Promise<void> {
  const saved = getTopicSession(chatId, topicId);
  if (!(saved?.pinSession ?? true)) return;

  const liveName = opts.pid !== undefined ? readLiveSessionName(opts.pid, opts.registryBaseDir) : undefined;
  const name = liveName ?? saved?.name;
  if (!name) return;

  const text = pinText(name, saved?.model);
  if (saved?.pinnedMessageId && saved.pinnedText === text) return;

  if (saved?.pinnedMessageId) {
    try {
      await api.editMessageText(chatId, saved.pinnedMessageId, text);
      updateTopicSession(chatId, topicId, { pinnedText: text });
      return;
    } catch (err) {
      const desc = errText(err);
      if (/not modified/i.test(desc)) {
        // The message already says this — only our pinnedText memory was stale.
        updateTopicSession(chatId, topicId, { pinnedText: text });
        return;
      }
      // Only a hand-deleted pin message justifies recreating (and re-pinning);
      // a transient failure must NOT — that path would double-pin on recovery.
      if (!/message to edit not found|MESSAGE_ID_INVALID/i.test(desc)) {
        log(`[pin] edit failed for topic=${topicId}: ${desc}`);
        return;
      }
    }
  }

  let sent: { message_id: number };
  try {
    sent = await api.sendMessage(chatId, text, { message_thread_id: topicId, disable_notification: true });
  } catch (err) {
    log(`[pin] send failed for topic=${topicId}: ${errText(err)}`);
    return;
  }

  try {
    await api.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
  } catch (err) {
    // Most likely: the bot lacks the "Pin messages" admin right. Don't leave
    // the unpinned carrier message behind, and say so once per topic.
    await api.deleteMessage(chatId, sent.message_id).catch(() => {});
    log(`[pin] pin failed for topic=${topicId}: ${errText(err)}`);
    const key = topicKey(chatId, topicId);
    if (!pinFailureNotified.has(key)) {
      pinFailureNotified.add(key);
      await api
        .sendMessage(chatId, "⚠️ I can't pin messages here — give me the “Pin messages” admin right, or turn this off with /pin.", {
          message_thread_id: topicId,
        })
        .catch(() => {});
    }
    return;
  }

  updateTopicSession(chatId, topicId, { pinnedMessageId: sent.message_id, pinnedText: text });
}

/** /pin off: unpin + delete the tracked message and forget it. Best-effort. */
export async function removeSessionPin(api: PinApi, chatId: number, topicId: number): Promise<void> {
  const saved = getTopicSession(chatId, topicId);
  if (!saved?.pinnedMessageId) return;
  await api.unpinChatMessage(chatId, saved.pinnedMessageId).catch(() => {});
  await api.deleteMessage(chatId, saved.pinnedMessageId).catch(() => {});
  updateTopicSession(chatId, topicId, { pinnedMessageId: undefined, pinnedText: undefined });
}
