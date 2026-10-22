import { loadProjects } from "./config.js";

/**
 * Group membership IS the access boundary (README): being in ownerTelegramIds
 * lets you talk to the bot, but reaching a project from a DM additionally
 * requires membership in the group that hosts its topic. Verified live via
 * getChatMember and cached briefly — routing shouldn't cost an API call per
 * message, and a 5-minute staleness window on revoked membership is acceptable
 * for a chat product.
 */
export interface ChatMemberApi {
  getChatMember(chatId: number, userId: number): Promise<{ status: string }>;
}

const MEMBER_STATUSES = new Set(["creator", "administrator", "member"]);
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { ok: boolean; at: number }>();

export async function isChatMember(api: ChatMemberApi, chatId: number, userId: number): Promise<boolean> {
  const key = `${chatId}:${userId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let ok = false;
  try {
    const m = await api.getChatMember(chatId, userId);
    ok = MEMBER_STATUSES.has(m.status);
  } catch {
    ok = false; // not in the chat (Telegram errors on non-members) or API hiccup — deny
  }
  cache.set(key, { ok, at: Date.now() });
  return ok;
}

/** Keep items whose group the user belongs to; chatId-less items pass through
 *  (they resolve to "no-chat" downstream, which is its own honest message). */
export async function filterByMembership<T extends { chatId?: number }>(
  api: ChatMemberApi,
  items: readonly T[],
  userId: number,
): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) {
    if (item.chatId == null || (await isChatMember(api, item.chatId, userId))) out.push(item);
  }
  return out;
}

/** Distinct group chat ids across all projects (for per-owner membership precomputes). */
export function distinctProjectChatIds(configDir?: string): number[] {
  return [...new Set(loadProjects(configDir).projects.map((p) => p.chatId).filter((c): c is number => c != null))];
}

export function clearMembershipCache(): void {
  cache.clear();
}
