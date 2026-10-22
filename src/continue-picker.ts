import { fmtLocal } from "./schedule.js";
import type { ScheduledJob } from "./schedule-store.js";

/**
 * Pure logic behind the "continue when the limit resets" buttons on a quota
 * alert. Hitting the 5h cap usually happens mid-task, so the alert offers the
 * projects that were actually working and schedules a "Continue working"
 * message into each of them for the moment the bucket frees up.
 */

export const CONTINUE_MESSAGE = "Continue working";

/** Considered "was working when the limit hit" → ticked by default. */
const PRESELECT_WITHIN_MS = 30 * 60_000;
/** Considered worth offering at all. */
const ACTIVE_WITHIN_MS = 6 * 3_600_000;
const MAX_CANDIDATES = 8;

export interface CandidateProject {
  name: string;
  chatId?: number;
  topicId: number;
}

/** Per-topic runtime facts the picker needs, looked up by the caller. */
export interface TopicActivity {
  lastActiveAt?: number;
  running?: boolean;
}

export interface ContinueCandidate {
  chatId: number;
  topicId: number;
  name: string;
  lastActiveAt?: number;
  running: boolean;
  preselected: boolean;
}

export interface CandidateOpts {
  activeWithinMs?: number;
  preselectWithinMs?: number;
  max?: number;
}

/**
 * Projects worth offering, most-relevant first: a live process beats a merely
 * recent session, then most recently active. Projects with no known chat are
 * skipped — there'd be nowhere to deliver the message.
 */
export function continueCandidates(
  projects: readonly CandidateProject[],
  activity: (chatId: number, topicId: number) => TopicActivity | undefined,
  now: number,
  opts: CandidateOpts = {},
): ContinueCandidate[] {
  const activeWithin = opts.activeWithinMs ?? ACTIVE_WITHIN_MS;
  const preselectWithin = opts.preselectWithinMs ?? PRESELECT_WITHIN_MS;
  const max = opts.max ?? MAX_CANDIDATES;

  const out: ContinueCandidate[] = [];
  for (const p of projects) {
    if (typeof p.chatId !== "number") continue;
    const state = activity(p.chatId, p.topicId) ?? {};
    const running = state.running === true;
    const age = state.lastActiveAt === undefined ? Infinity : now - state.lastActiveAt;
    if (!running && age > activeWithin) continue;
    out.push({
      chatId: p.chatId,
      topicId: p.topicId,
      name: p.name,
      lastActiveAt: state.lastActiveAt,
      running,
      preselected: running || age <= preselectWithin,
    });
  }

  out.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  });
  return out.slice(0, max);
}

/**
 * When to send the continue message: just after the bucket resets. Clamped to
 * the future so a reset time that already passed (or is missing) still yields a
 * usable moment rather than firing instantly into a still-capped session.
 */
export function continueRunAt(resetsAt: string | null | undefined, now: number, bufferMs = 60_000): number {
  const at = resetsAt ? new Date(resetsAt).getTime() : NaN;
  if (Number.isNaN(at)) return now + bufferMs;
  return Math.max(at + bufferMs, now + bufferMs);
}

/**
 * A picker is only meaningful until its limit has reset — after that the quota
 * is back and you'd just message the project. Pressing a stale one would
 * otherwise schedule work for "now + 1 min" out of nowhere.
 */
export const PICKER_STALE_AFTER_RESET_MS = 30 * 60_000;

export function pickerIsStale(
  resetsAt: string | null | undefined,
  now: number,
  staleAfterMs = PICKER_STALE_AFTER_RESET_MS,
): boolean {
  const at = resetsAt ? new Date(resetsAt).getTime() : NaN;
  if (Number.isNaN(at)) return false; // unknown reset time — let it through
  return now > at + staleAfterMs;
}

/** Tolerance for treating two continue runs as the same scheduled run. */
const DUPLICATE_WINDOW_MS = 5 * 60_000;

export interface ExistingContinueJob {
  chatId: number;
  topicId: number;
  message: string;
  nextRunAt: number;
}

/**
 * Drop candidates that already have a continue run scheduled for the same
 * moment. Every owner gets their own picker from the same alert, so two people
 * confirming would otherwise queue the same prompt twice per project.
 */
export function withoutAlreadyScheduled<T extends { chatId: number; topicId: number }>(
  selected: readonly T[],
  existing: readonly ExistingContinueJob[],
  runAt: number,
  toleranceMs = DUPLICATE_WINDOW_MS,
): { fresh: T[]; duplicates: T[] } {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const c of selected) {
    const clash = existing.some((j) =>
      j.chatId === c.chatId
      && j.topicId === c.topicId
      && j.message === CONTINUE_MESSAGE
      && Math.abs(j.nextRunAt - runAt) <= toleranceMs);
    (clash ? duplicates : fresh).push(c);
  }
  return { fresh, duplicates };
}

/** One one-shot job per selected project, all firing at the same moment. */
export function continueJobs(
  selected: readonly ContinueCandidate[],
  runAt: number,
  createdBy: number,
  now: number,
  nextId: () => string,
): ScheduledJob[] {
  return selected.map((c) => ({
    id: nextId(),
    chatId: c.chatId,
    topicId: c.topicId,
    project: c.name,
    message: CONTINUE_MESSAGE,
    kind: "once" as const,
    runAt,
    describe: `after quota reset · ${fmtLocal(runAt, now)}`,
    nextRunAt: runAt,
    createdBy,
    createdAt: now,
  }));
}
