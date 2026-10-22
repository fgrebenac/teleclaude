import type { Message } from "grammy/types";

export function getTopicId(message: Message): number | undefined {
  return message.message_thread_id;
}

export function isGeneralTopic(topicId: number | undefined): boolean {
  return topicId === undefined || topicId === 0 || topicId === 1;
}

/**
 * Canonical composite key for a (chat, topic) pair. Telegram topic IDs are only
 * unique within a chat, so everything that keys per-conversation state — the
 * ProcessManager map, session-state, the daemon's reply counters, message.ts
 * timers — must use this. One helper so the order can never drift.
 */
export function topicKey(chatId: number, topicId: number): string {
  return `${chatId}:${topicId}`;
}
