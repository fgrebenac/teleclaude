import type { Bot, Context } from "grammy";
import { getTopicId, isGeneralTopic } from "../bot.js";
import { getProject, loadProjects, getProjectsForChat } from "../config.js";
import { resolveRoute } from "../commands.js";
import { filterByMembership } from "../membership.js";
import { escapeHtml } from "../telegram-format.js";
import { log } from "../log.js";
import { parseAt, parseEvery, parseFlags, nextRun, fmtLocal, fmtIn, parseHm, type ScheduleFlags } from "../schedule.js";
import {
  addSchedule, listSchedules, loadSchedules, removeSchedule, newJobId, resolveJobRef, type ScheduledJob,
} from "../schedule-store.js";
import { fetchAvailableModels, resolveModel, EFFORT_LEVELS } from "../models.js";
import { DIGEST_PRESETS, presetById, digestCron, buildDigestJob } from "../digest.js";

const MAX_LISTED = 20;
/** Keep a listing inside Telegram's 4096-char message limit. */
const MAX_LISTING_CHARS = 3600;
/** Bound how many jobs one chat can queue — a stray /every 1m shouldn't be unbounded. */
const MAX_JOBS_PER_CHAT = 50;

function stripCommand(text: string): string {
  return text.replace(/^\/\w+(@\w+)?\s*/, "");
}

/**
 * Jobs visible from where the command was sent:
 *  - project topic → that topic's jobs
 *  - group General → every job in that group
 *  - DM           → every job this user created (their jobs live in group chats)
 */
function scopedJobs(ctx: Context, topicId: number | undefined, configDir?: string): ScheduledJob[] {
  const chatId = ctx.chat!.id;
  if (ctx.chat!.type === "private") {
    return loadSchedules(configDir).jobs
      .filter((j) => j.createdBy === ctx.from?.id)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }
  return listSchedules(chatId, isGeneralTopic(topicId) ? undefined : topicId, configDir);
}

function fmtJob(job: ScheduledJob, now: number): string {
  const flagBits = [
    job.flags?.fresh ? "fresh session" : null,
    job.flags?.model ? `model ${job.flags.model}` : null,
    job.flags?.effort ? `effort ${job.flags.effort}` : null,
  ].filter(Boolean);
  const suffix = flagBits.length ? ` · ${flagBits.join(", ")}` : "";
  const preview = job.message.length > 80 ? `${job.message.slice(0, 80)}…` : job.message;
  return [
    `<code>${job.id}</code> → <b>${escapeHtml(job.project)}</b> · ${escapeHtml(job.describe)}${suffix}`,
    `   ${fmtLocal(job.nextRunAt, now)} (${fmtIn(job.nextRunAt, now)})`,
    `   💬 ${escapeHtml(preview)}`,
  ].join("\n");
}

/** Validate --model / --effort at creation time so a job can't fail hours later. */
async function validateFlags(flags: ScheduleFlags): Promise<{ ok: true; flags: ScheduleFlags } | { ok: false; error: string }> {
  const out: ScheduleFlags = { ...flags };
  if (flags.model) {
    const { models, fromApi } = await fetchAvailableModels();
    const resolved = resolveModel(flags.model, models, fromApi);
    if (!resolved) return { ok: false, error: `Unknown model "${flags.model}". Try /model to see what's available.` };
    out.model = resolved;
  }
  if (flags.effort && !EFFORT_LEVELS.includes(flags.effort)) {
    return { ok: false, error: `Unknown effort "${flags.effort}". Levels: ${EFFORT_LEVELS.join(", ")}` };
  }
  return { ok: true, flags: out };
}

/**
 * Render a listing that fits one Telegram message. Budgeted by characters as
 * well as count: 20 flag-heavy jobs can exceed the 4096-char limit, and an
 * over-long reply is simply rejected by the API.
 */
export function renderScheduleListing(
  jobs: readonly ScheduledJob[],
  now: number,
  maxChars = MAX_LISTING_CHARS,
  maxListed = MAX_LISTED,
): { lines: string[]; shown: ScheduledJob[] } {
  const shown: ScheduledJob[] = [];
  const rendered: string[] = [];
  let used = 0;
  for (const job of jobs.slice(0, maxListed)) {
    const text = fmtJob(job, now);
    if (used + text.length > maxChars) break;
    used += text.length + 1;
    shown.push(job);
    rendered.push(text);
  }
  const lines = [`<b>Schedules</b> (${jobs.length})`, "", ...rendered];
  if (jobs.length > shown.length) lines.push("", `…and ${jobs.length - shown.length} more — cancel some to see them.`);
  return { lines, shown };
}

async function handleCreate(ctx: Context, kind: "at" | "every", configDir?: string): Promise<void> {
  const message = ctx.message!;
  const topicId = getTopicId(message);
  const inTopic = !isGeneralTopic(topicId) && topicId !== undefined;
  const replyOpts = inTopic ? { message_thread_id: topicId } : {};
  const reply = (text: string) => ctx.reply(text, { parse_mode: "HTML", ...replyOpts });

  const now = Date.now();
  const argText = stripCommand(message.text ?? "");
  const parsed = kind === "at" ? parseAt(argText, now) : parseEvery(argText, now);
  if (!parsed.ok) { await reply(escapeHtml(parsed.error)); return; }

  // Resolve the target project: implied by a project topic, named otherwise.
  let target: { name: string; path: string; chatId: number; topicId: number };
  let rest = parsed.rest;
  if (inTopic) {
    const project = getProject(ctx.chat!.id, topicId, configDir);
    if (!project) { await reply("This topic is not linked to a project."); return; }
    target = { name: project.name, path: project.path, chatId: ctx.chat!.id, topicId };
  } else {
    const tokens = rest.split(/\s+/).filter(Boolean);
    const name = tokens[0]?.replace(/^\//, "");
    if (!name) { await reply("Which project? <code>/at 07:00 &lt;project&gt; &lt;message&gt;</code>"); return; }
    // A DM can target any project (same as /<project> routing); inside a group,
    // stay within that group — matching how /list, /delete and /status behave.
    const isPrivate = ctx.chat!.type === "private";
    const candidates = isPrivate
      ? await filterByMembership(ctx.api, loadProjects(configDir).projects, ctx.from!.id)
      : getProjectsForChat(ctx.chat!.id, configDir);
    const resolution = resolveRoute(candidates, name);
    if (resolution.status === "unknown") {
      const names = candidates.map((p) => p.name).join(", ");
      await reply(`No project "${escapeHtml(name)}"${isPrivate ? "" : " in this group"}. Projects: ${escapeHtml(names)}`);
      return;
    }
    if (resolution.status === "no-chat") {
      await reply(`⚠️ No chat known for "${escapeHtml(resolution.target.name)}" yet — send a message in its topic once first.`);
      return;
    }
    const t = resolution.target;
    target = { name: t.name, path: t.path, chatId: t.chatId!, topicId: t.topicId };
    rest = tokens.slice(1).join(" ");
  }

  const { flags, rest: body } = parseFlags(rest);
  if (!body.trim()) { await reply("Nothing to send — put the message after the time."); return; }

  const validated = await validateFlags(flags);
  if (!validated.ok) { await reply(escapeHtml(validated.error)); return; }

  const firstRun = nextRun(parsed.spec, now);
  if (firstRun === null) { await reply("That schedule has no next run."); return; }

  const existing = listSchedules(target.chatId, undefined, configDir).length;
  if (existing >= MAX_JOBS_PER_CHAT) {
    await reply(`This group already has ${existing} schedules (max ${MAX_JOBS_PER_CHAT}). Cancel some with /schedules first.`);
    return;
  }

  const job: ScheduledJob = {
    id: newJobId(configDir),
    chatId: target.chatId,
    topicId: target.topicId,
    project: target.name,
    message: body.trim(),
    kind: parsed.spec.kind,
    runAt: parsed.spec.runAt,
    cron: parsed.spec.cron,
    everyMs: parsed.spec.everyMs,
    describe: parsed.spec.describe,
    nextRunAt: firstRun,
    flags: Object.keys(validated.flags).length ? validated.flags : undefined,
    createdBy: ctx.from!.id,
    createdAt: now,
  };
  addSchedule(job, configDir);
  log(`[schedule] created ${job.id} kind=${job.kind} project=${job.project} next=${new Date(firstRun).toISOString()}`);

  const note = job.flags?.model || job.flags?.effort
    ? "\n<i>Note: --model/--effort persist for the topic, like /model.</i>"
    : "";
  await ctx.reply(
    `⏰ Scheduled <code>${job.id}</code>\n${fmtJob(job, now)}${note}`,
    {
      parse_mode: "HTML",
      ...replyOpts,
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel this", callback_data: `sched:del:${job.id}` }]] },
    },
  );
}

export function registerScheduleCommands(bot: Bot, configDir?: string): void {
  bot.command("at", async (ctx) => { await handleCreate(ctx, "at", configDir); });
  bot.command("every", async (ctx) => { await handleCreate(ctx, "every", configDir); });

  bot.command("schedules", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const inTopic = !isGeneralTopic(topicId) && topicId !== undefined;
    const replyOpts = inTopic ? { message_thread_id: topicId } : {};
    const now = Date.now();
    const jobs = scopedJobs(ctx, topicId, configDir);

    if (!jobs.length) {
      await ctx.reply(
        "No schedules here.\n\n<code>/at 07:00 &lt;project&gt; &lt;message&gt;</code>\n<code>/every mon-fri 09:30 &lt;project&gt; &lt;message&gt;</code>",
        { parse_mode: "HTML", ...replyOpts },
      );
      return;
    }

    const { lines, shown } = renderScheduleListing(jobs, now);
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      ...replyOpts,
      reply_markup: {
        inline_keyboard: shown.map((j) => [{ text: `❌ ${j.id} · ${j.project} · ${j.describe}`, callback_data: `sched:del:${j.id}` }]),
      },
    });
  });

  bot.command("unschedule", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const inTopic = !isGeneralTopic(topicId) && topicId !== undefined;
    const replyOpts = inTopic ? { message_thread_id: topicId } : {};
    const id = stripCommand(ctx.message!.text ?? "").trim().split(/\s+/)[0];
    if (!id) { await ctx.reply("Usage: /unschedule <id> (see /schedules)", replyOpts); return; }

    const jobs = scopedJobs(ctx, topicId, configDir);
    const resolved = resolveJobRef(jobs, id);
    if (resolved.status === "unknown") {
      await ctx.reply(`No schedule "${id}" here. Check /schedules.`, replyOpts);
      return;
    }
    if (resolved.status === "ambiguous") {
      await ctx.reply(
        `"${id}" matches ${resolved.matches.length} schedules (${resolved.matches.map((j) => j.id).join(", ")}) — use the full id.`,
        replyOpts,
      );
      return;
    }
    const job = resolved.job;

    removeSchedule(job.id, configDir);
    log(`[schedule] removed ${job.id} via /unschedule`);
    await ctx.reply(`🗑 Cancelled ${job.id} (${job.project} · ${job.describe})`, replyOpts);
  });

  bot.command("digest", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) {
      await ctx.reply("Run /digest inside a project topic — the digest is delivered there.");
      return;
    }
    const project = getProject(ctx.chat!.id, topicId, configDir);
    if (!project) {
      await ctx.reply("This topic is not linked to a project.", { message_thread_id: topicId });
      return;
    }

    const arg = stripCommand(ctx.message!.text ?? "").trim();
    let hm: { h: number; m: number } | null = null;
    if (arg) {
      hm = parseHm(arg);
      if (!hm) {
        await ctx.reply("Usage: /digest [HH:MM] — e.g. /digest or /digest 06:30", { message_thread_id: topicId });
        return;
      }
    }

    const buttons = DIGEST_PRESETS.map((p) => {
      const cron = digestCron(p, hm);
      const [min, hour] = cron.trim().split(/\s+/);
      return [{ text: p.label, callback_data: `digest:${p.id}:${hour.padStart(2, "0")}${min.padStart(2, "0")}` }];
    });
    const note = hm ? `\nTime override: ${String(hm.h).padStart(2, "0")}:${String(hm.m).padStart(2, "0")}` : "";
    await ctx.reply(
      `Pick a digest — it becomes a normal schedule (manage it with /schedules).${note}`,
      { message_thread_id: topicId, reply_markup: { inline_keyboard: buttons } },
    );
  });
}

/** Handle the ❌ buttons from /schedules and the creation ack. */
export async function handleScheduleCallback(bot: Bot, ctx: Context, data: string, configDir?: string): Promise<void> {
  const id = data.slice("sched:del:".length);
  const job = loadSchedules(configDir).jobs.find((j) => j.id === id);
  if (!job) { await ctx.answerCallbackQuery({ text: "Already gone" }); return; }

  // Callback payloads are attacker-shaped input in principle: treat them as a
  // job *reference*, not as authorization. A group button may cancel that
  // group's jobs; in a DM you may only cancel what you created.
  const chatId = ctx.callbackQuery?.message?.chat.id;
  const inPrivate = ctx.callbackQuery?.message?.chat.type === "private";
  const allowed = inPrivate ? job.createdBy === ctx.from?.id : job.chatId === chatId;
  if (!allowed) { await ctx.answerCallbackQuery({ text: "Not your schedule to cancel" }); return; }

  removeSchedule(job.id, configDir);
  log(`[schedule] removed ${job.id} via button`);
  await ctx.answerCallbackQuery({ text: `Cancelled ${job.id}` });

  const msg = ctx.callbackQuery?.message;
  if (msg && "text" in msg && msg.text) {
    // Keep the message but drop this job's button; strike nothing else out.
    const remaining = (msg.reply_markup?.inline_keyboard ?? [])
      .filter((row) => !row.some((b) => "callback_data" in b && b.callback_data === data));
    await bot.api.editMessageText(msg.chat.id, msg.message_id, `${msg.text}\n\n🗑 Cancelled ${job.id}.`, {
      reply_markup: { inline_keyboard: remaining },
    }).catch(() => {});
  }
}

/** Handle a /digest preset button: digest:<presetId>:<HHMM>. */
export async function handleDigestCallback(ctx: Context, data: string, configDir?: string): Promise<void> {
  const m = /^digest:([a-z]+):(\d{2})(\d{2})$/.exec(data);
  const preset = m ? presetById(m[1]) : undefined;
  const chatId = ctx.callbackQuery?.message?.chat.id;
  const topicId = ctx.callbackQuery?.message?.message_thread_id;
  if (!m || !preset || !chatId || !topicId) {
    await ctx.answerCallbackQuery({ text: "Expired — run /digest again" });
    return;
  }
  const project = getProject(chatId, topicId, configDir);
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  const cron = digestCron(preset, { h: Number(m[2]), m: Number(m[3]) });
  const now = Date.now();
  const firstRun = nextRun({ kind: "cron", cron, describe: "" }, now);
  if (firstRun === null) {
    await ctx.answerCallbackQuery({ text: "That schedule has no next run" });
    return;
  }

  const chatJobs = listSchedules(chatId, undefined, configDir);
  if (chatJobs.length >= MAX_JOBS_PER_CHAT) {
    await ctx.answerCallbackQuery({ text: `Too many schedules (max ${MAX_JOBS_PER_CHAT})` });
    return;
  }
  const dup = chatJobs.find((j) => j.topicId === topicId && j.cron === cron && j.message === preset.prompt);
  if (dup) {
    await ctx.answerCallbackQuery({ text: `Already scheduled (${dup.id})` });
    return;
  }

  const job = buildDigestJob(preset, cron, { chatId, topicId, name: project.name }, ctx.from!.id, now, firstRun, newJobId(configDir));
  addSchedule(job, configDir);
  log(`[digest] created ${job.id} preset=${preset.id} cron="${cron}" project=${project.name}`);
  await ctx.answerCallbackQuery({ text: "Scheduled" });

  const msg = ctx.callbackQuery?.message;
  if (msg) {
    await ctx.api.editMessageText(chatId, msg.message_id, `⏰ Scheduled <code>${job.id}</code>\n${fmtJob(job, now)}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel this", callback_data: `sched:del:${job.id}` }]] },
    }).catch(() => {});
  }
}
