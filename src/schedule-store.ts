import { readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { writeJsonAtomic } from "./fs-util.js";
import { logError } from "./log.js";
import type { ScheduleKind, ScheduleFlags } from "./schedule.js";

export interface ScheduledJob {
  /** Short random id — used by /unschedule and the ❌ buttons. */
  id: string;
  chatId: number;
  topicId: number;
  /** Project name at creation time, for listings (the (chat,topic) pair is authoritative). */
  project: string;
  message: string;
  kind: ScheduleKind;
  runAt?: number;
  cron?: string;
  everyMs?: number;
  /** Human description of the schedule, e.g. "daily at 07:00". */
  describe: string;
  /** Epoch ms of the next fire — recomputed after each run. */
  nextRunAt: number;
  flags?: ScheduleFlags;
  paused?: boolean;
  createdBy: number;
  createdAt: number;
  /** Epoch ms of the last *successful* delivery. */
  lastRunAt?: number;
  /** Delivery attempts for the current run — reset once it lands. Bounds retries. */
  attempts?: number;
  /** Epoch ms the last attempt started. Persisted before delivery, so a crash mid-run is visible. */
  lastAttemptAt?: number;
  /** Idempotency key for the current run's delivery — minted on the first
   *  attempt, reused by retries, cleared when the run resolves. */
  deliveryId?: string;
}

export interface SchedulesFile {
  jobs: ScheduledJob[];
}

function defaultDir(): string {
  return join(homedir(), ".teleclaude");
}

function filePath(dir?: string): string {
  return join(dir ?? defaultDir(), "schedules.json");
}

let cache: { dir: string; data: SchedulesFile } | undefined;

export function loadSchedules(dir?: string): SchedulesFile {
  const d = dir ?? defaultDir();
  if (cache?.dir === d) return cache.data;

  const file = filePath(d);
  let data: SchedulesFile = { jobs: [] };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (Array.isArray(parsed?.jobs)) data = { jobs: parsed.jobs };
    } catch (err) {
      // Same rule as the other state files: never crash-loop on a torn write,
      // and never silently overwrite the evidence.
      const backup = `${file}.corrupt-${Date.now()}`;
      try { renameSync(file, backup); } catch { /* ignore */ }
      logError(`[schedule] ${file} is corrupt — starting fresh, original saved as ${backup}`, err);
    }
  }
  cache = { dir: d, data };
  return data;
}

export function saveSchedules(data: SchedulesFile, dir?: string): void {
  const d = dir ?? defaultDir();
  mkdirSync(d, { recursive: true });
  writeJsonAtomic(filePath(d), data);
  cache = { dir: d, data };
}

/**
 * Short id for /unschedule and the ❌ buttons. 6 hex chars is plenty of entropy
 * at this scale, but collisions are checked against the live set anyway — a
 * duplicate id would make the wrong job cancellable.
 */
export function newJobId(dir?: string): string {
  const taken = new Set(loadSchedules(dir).jobs.map((j) => j.id));
  for (let i = 0; i < 10; i++) {
    const id = randomBytes(3).toString("hex");
    if (!taken.has(id)) return id;
  }
  return randomBytes(6).toString("hex"); // absurdly unlucky — widen instead of looping
}

export function addSchedule(job: ScheduledJob, dir?: string): void {
  const data = loadSchedules(dir);
  data.jobs.push(job);
  saveSchedules(data, dir);
}

/** Jobs for a chat, or for one topic within it, soonest first. */
export function listSchedules(chatId: number, topicId?: number, dir?: string): ScheduledJob[] {
  return loadSchedules(dir).jobs
    .filter((j) => j.chatId === chatId && (topicId === undefined || j.topicId === topicId))
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

/**
 * Resolve by exact id, or by a prefix that matches exactly one job. An ambiguous
 * prefix returns "ambiguous" rather than silently cancelling an arbitrary match.
 */
export function resolveJobRef<T extends { id: string }>(
  jobs: readonly T[],
  idOrPrefix: string,
): { status: "ok"; job: T } | { status: "ambiguous"; matches: T[] } | { status: "unknown" } {
  const exact = jobs.find((j) => j.id === idOrPrefix);
  if (exact) return { status: "ok", job: exact };
  const matches = jobs.filter((j) => j.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { status: "ok", job: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "unknown" };
}

/** Resolve by exact id or unique id prefix, scoped to a chat. */
export function findSchedule(chatId: number, idOrPrefix: string, dir?: string): ScheduledJob | undefined {
  const jobs = loadSchedules(dir).jobs.filter((j) => j.chatId === chatId);
  const resolved = resolveJobRef(jobs, idOrPrefix);
  return resolved.status === "ok" ? resolved.job : undefined;
}

/** Remove by id (any chat — callers scope first). Returns the removed job. */
export function removeSchedule(id: string, dir?: string): ScheduledJob | undefined {
  const data = loadSchedules(dir);
  const idx = data.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return undefined;
  const [removed] = data.jobs.splice(idx, 1);
  saveSchedules(data, dir);
  return removed;
}

export function updateSchedule(id: string, updates: Partial<ScheduledJob>, dir?: string): void {
  const data = loadSchedules(dir);
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  Object.assign(job, updates);
  saveSchedules(data, dir);
}

/** Clear the cache (for testing). */
export function clearScheduleCache(): void {
  cache = undefined;
}
