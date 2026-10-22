import type { Bot, Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { randomBytes } from "crypto";
import { loadProjects } from "../config.js";
import { getTopicSession } from "../session-state.js";
import { addSchedule, loadSchedules, newJobId } from "../schedule-store.js";
import { fmtLocal, fmtIn } from "../schedule.js";
import { log } from "../log.js";
import {
  continueCandidates, continueJobs, continueRunAt, pickerIsStale, withoutAlreadyScheduled,
  CONTINUE_MESSAGE, type ContinueCandidate,
} from "../continue-picker.js";
import type { ProcessManager } from "../processes.js";

/**
 * The "continue when the limit resets" picker attached to a quota-exhausted
 * alert. Hitting the cap mid-task means the work just stops; these buttons
 * schedule a "Continue working" message into the projects that were running,
 * timed for the moment the bucket frees up.
 *
 * Selection state is in memory: the buttons are a live UI, not durable state.
 * A restart loses the pending picker (the callback answers "expired"), but
 * anything already scheduled lives in schedules.json and survives.
 */

interface Picker {
  resetsAt: string | null;
  items: ContinueCandidate[];
  selected: Set<number>;
  createdAt: number;
}

const pickers = new Map<string, Picker>();
const MAX_PICKERS = 50;

export interface ContinueOffer {
  token: string;
  items: ContinueCandidate[];
  keyboard: InlineKeyboardButton[][];
}

function keyboardFor(token: string, picker: Picker): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = picker.items.map((item, i) => [{
    text: `${picker.selected.has(i) ? "✅" : "⬜"} ${item.name}${item.running ? " 🟢" : ""}`,
    callback_data: `cont:t:${token}:${i}`,
  }]);
  rows.push([
    { text: "⏰ Continue at reset", callback_data: `cont:go:${token}` },
    { text: "✖️ No thanks", callback_data: `cont:x:${token}` },
  ]);
  return rows;
}

/**
 * Build a picker for one alert message, or undefined when nothing was recently
 * active — no point offering buttons that would schedule nothing.
 */
export function buildContinueOffer(
  pm: ProcessManager,
  resetsAt: string | null,
  now: number,
  configDir?: string,
  allowChat?: (chatId: number) => boolean,
): ContinueOffer | undefined {
  const projects = loadProjects(configDir).projects
    .filter((p) => p.chatId == null || !allowChat || allowChat(p.chatId));
  const items = continueCandidates(
    projects,
    (chatId, topicId) => ({
      lastActiveAt: getTopicSession(chatId, topicId)?.lastActiveAt,
      running: pm.isRunning(chatId, topicId),
    }),
    now,
  );
  if (!items.length) return undefined;

  // Drop pickers whose limit has already reset — they can't be acted on anyway.
  for (const [key, p] of pickers) if (pickerIsStale(p.resetsAt, now)) pickers.delete(key);

  if (pickers.size >= MAX_PICKERS) {
    const oldest = [...pickers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) pickers.delete(oldest[0]);
  }

  const token = randomBytes(3).toString("hex");
  const picker: Picker = {
    resetsAt,
    items,
    selected: new Set(items.flatMap((item, i) => (item.preselected ? [i] : []))),
    createdAt: now,
  };
  pickers.set(token, picker);
  log(`[continue] offer ${token} — ${items.length} candidate(s), ${picker.selected.size} preselected`);
  return { token, items, keyboard: keyboardFor(token, picker) };
}

/** Handle `cont:*` callbacks. Returns false if the data wasn't ours. */
export async function handleContinueCallback(
  bot: Bot,
  ctx: Context,
  data: string,
  configDir?: string,
): Promise<void> {
  const [, action, token, indexRaw] = data.split(":");
  const picker = pickers.get(token);
  const msg = ctx.callbackQuery?.message;

  if (!picker) {
    await ctx.answerCallbackQuery({ text: "This picker expired — use /at to schedule instead." });
    if (msg) {
      await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [] } })
        .catch(() => {});
    }
    return;
  }

  if (action === "t") {
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || index >= picker.items.length) {
      await ctx.answerCallbackQuery({ text: "Unknown project" });
      return;
    }
    if (picker.selected.has(index)) picker.selected.delete(index);
    else picker.selected.add(index);
    await ctx.answerCallbackQuery({ text: `${picker.items[index].name}: ${picker.selected.has(index) ? "on" : "off"}` });
    if (msg) {
      await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, {
        reply_markup: { inline_keyboard: keyboardFor(token, picker) },
      }).catch(() => {});
    }
    return;
  }

  if (action === "x") {
    pickers.delete(token);
    await ctx.answerCallbackQuery({ text: "Dismissed" });
    if (msg && "text" in msg && msg.text) {
      await bot.api.editMessageText(msg.chat.id, msg.message_id, msg.text, {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    return;
  }

  if (action !== "go") {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  const selected = [...picker.selected].sort((a, b) => a - b).map((i) => picker.items[i]);
  if (!selected.length) {
    await ctx.answerCallbackQuery({ text: "Pick at least one project first" });
    return;
  }

  const now = Date.now();
  if (pickerIsStale(picker.resetsAt, now)) {
    pickers.delete(token);
    log(`[continue] ${token} pressed after the limit already reset — refusing`);
    await ctx.answerCallbackQuery({ text: "That limit already reset — just message the project, or use /at." });
    if (msg && "text" in msg && msg.text) {
      await bot.api.editMessageText(msg.chat.id, msg.message_id,
        `${msg.text}\n\n⏰ Too late to schedule from this alert — the limit already reset.`,
        { reply_markup: { inline_keyboard: [] } },
      ).catch(() => {});
    }
    return;
  }

  const runAt = continueRunAt(picker.resetsAt, now);
  // Each owner gets their own picker from the same alert; don't queue the same
  // prompt twice because two of them confirmed.
  const { fresh, duplicates } = withoutAlreadyScheduled(selected, loadSchedules(configDir).jobs, runAt);
  if (!fresh.length) {
    pickers.delete(token);
    await ctx.answerCallbackQuery({ text: "Already scheduled for this reset" });
    return;
  }

  const jobs = continueJobs(fresh, runAt, ctx.from?.id ?? 0, now, () => newJobId(configDir));
  for (const job of jobs) addSchedule(job, configDir);
  pickers.delete(token);

  log(`[continue] scheduled ${jobs.length} job(s) at ${new Date(runAt).toISOString()}: ${jobs.map((j) => j.project).join(", ")}${duplicates.length ? ` (${duplicates.length} already scheduled)` : ""}`);
  await ctx.answerCallbackQuery({ text: `Scheduled ${jobs.length} project(s)` });

  const summary = [
    `⏰ "${CONTINUE_MESSAGE}" scheduled for ${fmtLocal(runAt, now)} (${fmtIn(runAt, now)}):`,
    ...jobs.map((j) => `• ${j.project} — /unschedule ${j.id}`),
    ...(duplicates.length ? [`(${duplicates.map((d) => d.name).join(", ")} already had one scheduled.)`] : []),
  ].join("\n");
  if (msg && "text" in msg && msg.text) {
    await bot.api.editMessageText(msg.chat.id, msg.message_id, `${msg.text}\n\n${summary}`, {
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  } else if (msg) {
    await bot.api.sendMessage(msg.chat.id, summary).catch(() => {});
  }
}

/** Drop all pending pickers (for testing). */
export function clearContinuePickers(): void {
  pickers.clear();
}
