import { readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { Bot } from "grammy";
import { escapeHtml } from "../telegram-format.js";
import { addProject, getProjectByName, findRouteCollision } from "../config.js";
import { preTrustWorkspace } from "../claude-trust.js";

// Path registry: short ID → absolute path (in-memory, cleared on restart)
const lsBrowser = new Map<string, string>();
let lsBrowserCounter = 0;

const LS_BROWSER_MAX = 500;

export function lsRegister(absPath: string): string {
  const id = String(lsBrowserCounter++);
  lsBrowser.set(id, absPath);
  // Evict oldest entries to keep memory bounded
  if (lsBrowser.size > LS_BROWSER_MAX) {
    const oldest = lsBrowser.keys().next().value;
    if (oldest !== undefined) lsBrowser.delete(oldest);
  }
  return id;
}

export function lsLookup(id: string): string | undefined {
  return lsBrowser.get(id);
}

// topicId → path awaiting custom project name input
export const pendingLsName = new Map<number, string>();

export async function sendLsListing(
  bot: Bot,
  chatId: number,
  absPath: string,
  replyToMsgId?: number,
  editMsgId?: number,
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = readdirSync(absPath)
      .filter((e) => {
        if (e.startsWith(".")) return false;
        try { return statSync(join(absPath, e)).isDirectory(); } catch { return false; }
      })
      .sort();
  } catch {
    const text = `❌ Cannot read directory: <code>${escapeHtml(absPath)}</code>`;
    if (editMsgId) {
      await bot.api.editMessageText(chatId, editMsgId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    } else {
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
    }
    return;
  }

  const currentId = lsRegister(absPath);
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  // Back button (if not at root)
  if (absPath !== "/") {
    const parentId = lsRegister(dirname(absPath));
    keyboard.push([{ text: "⬅️ Back", callback_data: `ls:${parentId}` }]);
  }

  // One button per subdirectory (max 95 to stay under Telegram's 100-button limit)
  for (const entry of entries.slice(0, 95)) {
    const childPath = join(absPath, entry);
    const childId = lsRegister(childPath);
    keyboard.push([{ text: `📁 ${entry}`, callback_data: `ls:${childId}` }]);
  }

  // "Use this folder" button
  keyboard.push([{ text: "✅ Use this folder", callback_data: `lsuse:${currentId}` }]);

  const header = entries.length === 0
    ? `📂 <code>${escapeHtml(absPath)}</code>\n<i>No subdirectories</i>`
    : `📂 <code>${escapeHtml(absPath)}</code>`;

  if (editMsgId) {
    await bot.api.editMessageText(chatId, editMsgId, header, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
  } else {
    await bot.api.sendMessage(chatId, header, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
      ...(replyToMsgId ? { reply_parameters: { message_id: replyToMsgId } } : {}),
    }).catch(() => {});
  }
}

export async function createProjectFromPath(
  bot: Bot,
  chatId: number,
  msgId: number | undefined,
  name: string,
  path: string,
  configDir?: string,
): Promise<void> {
  try {
    if (getProjectByName(chatId, name, configDir)) {
      const text = `❌ Project "${escapeHtml(name)}" already exists.`;
      if (msgId) await bot.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }).catch(() => {});
      else await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    // Two names that fold to the same /command can't coexist — routing and the
    // command menu couldn't tell them apart.
    const clash = findRouteCollision(name, configDir);
    if (clash) {
      const text = `❌ "${escapeHtml(name)}" collides with "${escapeHtml(clash.name)}" — both become the same /command. Use a custom name.`;
      if (msgId) await bot.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }).catch(() => {});
      else await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    preTrustWorkspace(path);
    const topicResult = await bot.api.createForumTopic(chatId, name);
    addProject({ name, path, chatId, topicId: topicResult.message_thread_id, createdAt: new Date().toISOString() }, configDir);
    const text = `✅ Project "<b>${escapeHtml(name)}</b>" created.`;
    if (msgId) await bot.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }).catch(() => {});
    else await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const text = `❌ Failed: ${escapeHtml(msg)}`;
    if (msgId) await bot.api.editMessageText(chatId, msgId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }).catch(() => {});
    else await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch(() => {});
  }
}
