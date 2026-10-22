import type { Bot } from "grammy";
import { randomUUID } from "crypto";
import { getProject, loadConfig } from "./config.js";
import { log, logError } from "./log.js";
import { sendToChannel } from "./handlers/message.js";
import { dueJobs, nextRun, fmtLocal, type ScheduleSpec } from "./schedule.js";
import { loadSchedules, removeSchedule, updateSchedule, type ScheduledJob } from "./schedule-store.js";
import { updateTopicSession } from "./session-state.js";
import type { ProcessManager } from "./processes.js";
import { topicKey } from "./bot.js";
import { QuotaGate, type GateDecision } from "./budget-gate.js";

const TICK_MS = 30_000;
/**
 * How late a run may be and still fire. Covers a restart/deploy or a short
 * sleep; anything older is skipped so a week of downtime can't dump a backlog
 * of stale prompts into your topics.
 */
export const GRACE_MS = 30 * 60_000;
/** Delivery attempts per run before giving up. */
export const MAX_ATTEMPTS = 3;
/** Wait between attempts when delivery didn't reach Claude. */
export const RETRY_DELAY_MS = 5 * 60_000;
/** Cap on a single delivery so a hung socket can't wedge the tick forever. */
const DELIVERY_TIMEOUT_MS = 4 * 60_000;
/** Cap on a Telegram send from the scheduler (grammy has no default timeout). */
const TELEGRAM_TIMEOUT_MS = 30_000;
/** A tick running longer than this is presumed wedged; the guard is released. */
const WEDGE_MS = 15 * 60_000;
/** How long a quota-gated due job is pushed back before the next look. */
export const GATE_DEFER_MS = 15 * 60_000;
/** One ⏸ notice per topic per hour — deferrals repeat every GATE_DEFER_MS while gated. */
const GATE_NOTICE_INTERVAL_MS = 60 * 60_000;
const gateNoticeAt = new Map<string, number>();
const sharedGate = new QuotaGate();

export function specOf(job: ScheduledJob): ScheduleSpec {
  return { kind: job.kind, runAt: job.runAt, cron: job.cron, everyMs: job.everyMs, describe: job.describe };
}

/**
 * Bound an await so one unresponsive call can't stall the scheduler. The
 * underlying promise keeps running; we just stop waiting on it.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { logError(`[schedule] ${label} timed out after ${ms / 1000}s`); resolve(undefined); }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function notify(bot: Bot, chatId: number, text: string, topicId?: number, silent = true): Promise<unknown> {
  return withTimeout(
    bot.api.sendMessage(chatId, text, {
      ...(topicId === undefined ? {} : { message_thread_id: topicId }),
      disable_notification: silent,
    }).catch(() => {}),
    TELEGRAM_TIMEOUT_MS,
    "telegram send",
  );
}

/**
 * Advance a recurring job past `now` (or drop a one-shot / a recurring job with
 * no future run). `ran` distinguishes a delivered run from a skipped one, so
 * `lastRunAt` never claims a run that didn't happen.
 */
function rollForward(job: ScheduledJob, now: number, ran: boolean, configDir?: string): void {
  if (job.kind === "once") {
    removeSchedule(job.id, configDir);
    return;
  }
  const next = nextRun(specOf(job), now);
  if (next === null) {
    log(`[schedule] ${job.id} has no future run — removing`);
    removeSchedule(job.id, configDir);
    return;
  }
  updateSchedule(job.id, { nextRunAt: next, attempts: 0, deliveryId: undefined, ...(ran ? { lastRunAt: now } : {}) }, configDir);
}

let ticking = false;
let tickStartedAt = 0;

/**
 * Fire everything due.
 *
 * The attempt counter is persisted BEFORE delivery and the schedule is only
 * advanced once delivery actually reached Claude — `sendToChannel` reports
 * spawn failures, a blocked channel and POST errors instead of throwing, and a
 * run that never landed must not be recorded as done. A failed attempt is
 * retried in RETRY_DELAY_MS, up to MAX_ATTEMPTS, then given up on with a notice.
 * Persisting the attempt first also bounds a crash-during-delivery loop.
 */
export async function runDueJobs(
  bot: Bot,
  pm: ProcessManager,
  now: number,
  configDir?: string,
  gate: Pick<QuotaGate, "decide"> = sharedGate,
): Promise<void> {
  const { jobs } = loadSchedules(configDir);
  if (!jobs.length) return;
  const { due, missed } = dueJobs(jobs, now, GRACE_MS);

  for (const job of missed) {
    log(`[schedule] ${job.id} missed — was due ${fmtLocal(job.nextRunAt, now)}, skipping`);
    await notify(bot, job.chatId, `⏰ Skipped a scheduled run (due ${fmtLocal(job.nextRunAt, now)}) — I wasn't running then.`, job.topicId);
    rollForward(job, now, false, configDir);
  }

  // Budget gate: while the configured quota bucket is at/above the threshold,
  // defer scheduled runs instead of delivering them. Deliberately BEFORE the
  // attempt counter is spent — a deferral is not a failed delivery — and
  // deliberately scheduler-only: interactive messages are never gated.
  if (due.length > 0) {
    const threshold = loadConfig(configDir).defaults.schedulePauseAtPercent ?? 0;
    const decision: GateDecision = threshold > 0
      ? await gate.decide(threshold, "five_hour", now)
      : { gated: false };
    if (decision.gated) {
      for (const job of due) {
        log(`[schedule] ${job.id} deferred — quota at ${decision.utilization?.toFixed(0) ?? "?"}% (gate ${threshold}%)`);
        updateSchedule(job.id, { nextRunAt: now + GATE_DEFER_MS }, configDir);
        const noticeKey = topicKey(job.chatId, job.topicId);
        if (now - (gateNoticeAt.get(noticeKey) ?? 0) > GATE_NOTICE_INTERVAL_MS) {
          gateNoticeAt.set(noticeKey, now);
          await notify(
            bot,
            job.chatId,
            `⏸ Scheduled run deferred — Claude quota at ${decision.utilization?.toFixed(0) ?? "?"}% (threshold ${threshold}%). `
              + `Retrying every ${GATE_DEFER_MS / 60_000} min; runs resume automatically once usage drops.`,
            job.topicId,
          );
        }
      }
      return;
    }
  }

  for (const job of due) {
    const project = getProject(job.chatId, job.topicId, configDir);
    if (!project) {
      log(`[schedule] ${job.id} target project gone (chat=${job.chatId} topic=${job.topicId}) — removing`);
      removeSchedule(job.id, configDir);
      await notify(bot, job.chatId, `⏰ Dropped schedule ${job.id} — its project no longer exists.`);
      continue;
    }

    const attempt = (job.attempts ?? 0) + 1;
    if (attempt > MAX_ATTEMPTS) {
      log(`[schedule] ${job.id} giving up after ${job.attempts} failed attempts`);
      await notify(bot, job.chatId, `⏰ Gave up on this scheduled run after ${MAX_ATTEMPTS} attempts — Claude couldn't be reached.`, job.topicId, false);
      rollForward(job, now, false, configDir);
      continue;
    }
    // Persisted before delivery: a crash mid-run resumes with the attempt spent.
    // One delivery id per run, reused across attempts — the channel server
    // dedupes it, so a retry after a timed-out (but actually landed) delivery
    // can't inject the prompt twice into the same live session.
    const deliveryId = job.deliveryId ?? randomUUID();
    updateSchedule(job.id, { attempts: attempt, lastAttemptAt: now, deliveryId }, configDir);
    log(`[schedule] firing ${job.id} project=${project.name} kind=${job.kind} attempt=${attempt}/${MAX_ATTEMPTS} msg=${job.message.slice(0, 60)}`);

    let result: { ok: boolean; reason?: string } | undefined;
    try {
      const flags = job.flags ?? {};
      if (flags.model || flags.effort) {
        updateTopicSession(job.chatId, job.topicId, {
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.effort ? { effort: flags.effort } : {}),
        });
      }
      if (flags.fresh) {
        // Same as /new in a project topic: drop only the session id, keep
        // model/effort/permissions, then let sendToChannel spawn it clean.
        updateTopicSession(job.chatId, job.topicId, { sessionId: "", projectPath: project.path, sessionCwd: undefined });
      }
      // A persisted model/effort change only takes effect on spawn.
      if ((flags.fresh || flags.model || flags.effort) && pm.isRunning(job.chatId, job.topicId)) {
        pm.kill(job.chatId, job.topicId);
      }

      // Mirror the prompt so the topic shows what Claude is responding to.
      await notify(bot, job.chatId, `⏰ ${job.message}`, job.topicId);

      result = await withTimeout(
        sendToChannel(job.chatId, job.topicId, project.path, job.message, pm, bot, configDir, { deliveryId }),
        DELIVERY_TIMEOUT_MS,
        `delivery of ${job.id}`,
      );
      if (!result) result = { ok: false, reason: "delivery timed out" };
    } catch (err) {
      logError(`[schedule] ${job.id} delivery threw:`, err);
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) {
      rollForward(job, now, true, configDir);
      continue;
    }

    // Didn't reach Claude — keep the job and retry rather than recording a run
    // that never happened. sendToChannel has already told the user what broke.
    const retriesLeft = MAX_ATTEMPTS - attempt;
    logError(`[schedule] ${job.id} not delivered (${result.reason ?? "unknown"}), ${retriesLeft} retr${retriesLeft === 1 ? "y" : "ies"} left`);
    if (retriesLeft > 0) {
      updateSchedule(job.id, { nextRunAt: now + RETRY_DELAY_MS }, configDir);
      await notify(bot, job.chatId, `⏰ Scheduled run didn't start — ${result.reason ?? "delivery failed"}. Retrying in ${RETRY_DELAY_MS / 60_000} min.`, job.topicId);
    } else {
      await notify(bot, job.chatId, `⏰ Scheduled run failed — ${result.reason ?? "delivery failed"}. Giving up after ${MAX_ATTEMPTS} attempts.`, job.topicId, false);
      rollForward(job, now, false, configDir);
    }
  }
}

/** Start the 30s scheduler tick. Returns the timer so tests/shutdown can clear it. */
export function startScheduler(bot: Bot, pm: ProcessManager, configDir?: string): NodeJS.Timeout {
  const pending = loadSchedules(configDir).jobs.length;
  log(`[schedule] scheduler started — ${pending} job(s) persisted`);
  const timer = setInterval(() => {
    if (ticking) {
      // Every await inside a tick is bounded, so this should be impossible —
      // but a permanently stuck tick would silently stop all future runs, so
      // release the guard rather than wedge the scheduler for good.
      if (Date.now() - tickStartedAt > WEDGE_MS) {
        logError(`[schedule] tick has been running for ${Math.round((Date.now() - tickStartedAt) / 60_000)} min — releasing the guard`);
        ticking = false;
      }
      return; // a spawn+wait can outlast a tick; never overlap
    }
    ticking = true;
    tickStartedAt = Date.now();
    void runDueJobs(bot, pm, Date.now(), configDir)
      .catch((err) => logError("[schedule] tick failed:", err))
      .finally(() => { ticking = false; });
  }, TICK_MS);
  timer.unref();
  return timer;
}
