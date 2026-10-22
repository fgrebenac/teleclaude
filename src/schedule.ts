/**
 * Pure parsing + timing logic for scheduled messages (`/at`, `/every`).
 *
 * Delivery is deliberately NOT here: a job is just "at time T, inject this text
 * into this topic", and the runner (`scheduler.ts`) hands that to the same
 * sendToChannel path a human message takes. Everything in this file is pure so
 * the time math — the part that's easy to get subtly wrong — is testable.
 *
 * All wall-clock parsing is in the HOST's local timezone, which is what you mean
 * when you type "07:00" into Telegram.
 */

export type ScheduleKind = "once" | "cron" | "interval";

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** once: absolute epoch ms */
  runAt?: number;
  /** cron: canonical 5-field expression (min hour dom month dow) */
  cron?: string;
  /** interval: fixed period in ms */
  everyMs?: number;
  /** Human description for acks and `/schedules`, e.g. "daily at 07:00" */
  describe: string;
}

export type ParseResult =
  | { ok: true; spec: ScheduleSpec; rest: string }
  | { ok: false; error: string };

export interface ScheduleFlags {
  /** Start a fresh session (drop the persisted sessionId) before delivering. */
  fresh?: boolean;
  model?: string;
  effort?: string;
}

// --- small time helpers ---

/** Epoch ms for a local wall-clock time. */
function localTs(y: number, monthIdx: number, d: number, h: number, min: number): number {
  return new Date(y, monthIdx, d, h, min, 0, 0).getTime();
}

export function parseHm(token: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Aug 1 07:00" — local, no year unless it differs from `now`. */
export function fmtLocal(ts: number, now?: number): string {
  const d = new Date(ts);
  const year = now !== undefined && new Date(now).getFullYear() !== d.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtIn(ts: number, now: number): string {
  const ms = ts - now;
  if (ms <= 0) return "overdue";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h}h ${mins % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

// --- cron subset ---

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  /** null = "*" — matters for the dom/dow OR rule below. */
  doms: Set<number> | null;
  months: Set<number>;
  dows: Set<number> | null;
}

function parseField(field: string, min: number, max: number, mapValue?: (n: number) => number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const step = part.split("/");
    if (step.length > 2) return null;
    const every = step.length === 2 ? Number(step[1]) : 1;
    if (!Number.isInteger(every) || every < 1) return null;
    let lo: number;
    let hi: number;
    if (step[0] === "*") {
      lo = min; hi = max;
    } else {
      const range = step[0].split("-");
      if (range.length > 2) return null;
      lo = Number(range[0]);
      hi = range.length === 2 ? Number(range[1]) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += every) out.add(mapValue ? mapValue(v) : v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression (min hour dom month dow). Returns null if invalid. */
export function parseCron(expr: string): CronFields | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minutes = parseField(f[0], 0, 59);
  const hours = parseField(f[1], 0, 23);
  const doms = f[2] === "*" ? null : parseField(f[2], 1, 31);
  const months = parseField(f[3], 1, 12);
  // cron allows 7 for Sunday
  const dows = f[4] === "*" ? null : parseField(f[4], 0, 7, (n) => n % 7);
  if (!minutes || !hours || !months) return null;
  if (f[2] !== "*" && !doms) return null;
  if (f[4] !== "*" && !dows) return null;
  return { minutes, hours, doms, months, dows };
}

/**
 * Next timestamp strictly after `from` that matches the expression, or null if
 * there's none within a year (e.g. Feb 30). Day-then-time iteration rather than
 * minute-stepping so a sparse expression stays cheap.
 *
 * Follows real cron's quirk: when BOTH day-of-month and day-of-week are
 * restricted, a day matching either one qualifies.
 */
export function nextCronRun(fields: CronFields, from: number): number | null {
  const hours = [...fields.hours].sort((a, b) => a - b);
  const minutes = [...fields.minutes].sort((a, b) => a - b);
  const start = new Date(from);
  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!fields.months.has(day.getMonth() + 1)) continue;
    const domOk = fields.doms?.has(day.getDate()) ?? null;
    const dowOk = fields.dows?.has(day.getDay()) ?? null;
    const dayMatches = domOk === null && dowOk === null ? true
      : domOk !== null && dowOk !== null ? domOk || dowOk
      : (domOk ?? dowOk)!;
    if (!dayMatches) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const ts = localTs(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (ts > from) return ts;
      }
    }
  }
  return null;
}

/** Next fire time for a spec, or null if it has none left (a past one-shot). */
export function nextRun(spec: ScheduleSpec, from: number): number | null {
  if (spec.kind === "once") return spec.runAt !== undefined && spec.runAt > from ? spec.runAt : null;
  if (spec.kind === "interval") return spec.everyMs ? from + spec.everyMs : null;
  const fields = spec.cron ? parseCron(spec.cron) : null;
  return fields ? nextCronRun(fields, from) : null;
}

// --- `/at` ---

const RELATIVE = /^\+(\d+)(m|min|mins|h|hr|hrs|d)$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const AT_USAGE = "Usage: /at <HH:MM | tomorrow HH:MM | YYYY-MM-DD HH:MM | +30m> [project] <message>";

export function parseAt(argText: string, now: number): ParseResult {
  const tokens = argText.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, error: AT_USAGE };

  const rel = RELATIVE.exec(tokens[0]);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("d") ? n * 86_400_000 : unit.startsWith("h") ? n * 3_600_000 : n * 60_000;
    if (ms <= 0) return { ok: false, error: "That delay is zero — pick something in the future." };
    const runAt = now + ms;
    return { ok: true, spec: { kind: "once", runAt, describe: fmtLocal(runAt, now) }, rest: tokens.slice(1).join(" ") };
  }

  const date = DATE.exec(tokens[0]);
  if (date) {
    const hm = tokens[1] ? parseHm(tokens[1]) : null;
    if (!hm) return { ok: false, error: `Missing or invalid time after ${tokens[0]}. ${AT_USAGE}` };
    const [y, mo, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const runAt = localTs(y, mo - 1, d, hm.h, hm.m);
    // Date() silently normalizes an impossible date (Feb 30 → Mar 2), and NaN
    // never happens — so verify the fields survived the round trip.
    const back = new Date(runAt);
    if (back.getFullYear() !== y || back.getMonth() !== mo - 1 || back.getDate() !== d) {
      return { ok: false, error: `No such date: ${tokens[0]}` };
    }
    if (Number.isNaN(runAt)) return { ok: false, error: `Invalid date: ${tokens[0]}` };
    if (runAt <= now) return { ok: false, error: `${fmtLocal(runAt, now)} is in the past.` };
    return { ok: true, spec: { kind: "once", runAt, describe: fmtLocal(runAt, now) }, rest: tokens.slice(2).join(" ") };
  }

  if (/^tomorrow$/i.test(tokens[0])) {
    const hm = tokens[1] ? parseHm(tokens[1]) : null;
    if (!hm) return { ok: false, error: `Missing or invalid time after "tomorrow". ${AT_USAGE}` };
    const d = new Date(now);
    const runAt = localTs(d.getFullYear(), d.getMonth(), d.getDate() + 1, hm.h, hm.m);
    return { ok: true, spec: { kind: "once", runAt, describe: fmtLocal(runAt, now) }, rest: tokens.slice(2).join(" ") };
  }

  const hm = parseHm(tokens[0]);
  if (hm) {
    const d = new Date(now);
    let runAt = localTs(d.getFullYear(), d.getMonth(), d.getDate(), hm.h, hm.m);
    if (runAt <= now) runAt = localTs(d.getFullYear(), d.getMonth(), d.getDate() + 1, hm.h, hm.m);
    return { ok: true, spec: { kind: "once", runAt, describe: fmtLocal(runAt, now) }, rest: tokens.slice(1).join(" ") };
  }

  return { ok: false, error: `Don't understand the time "${tokens[0]}". ${AT_USAGE}` };
}

// --- `/every` ---

const DOW_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const INTERVAL = /^(\d+)(m|min|mins|h|hr|hrs)$/i;

const EVERY_USAGE = 'Usage: /every <day HH:MM | mon-fri HH:MM | 30m | "0 7 * * 1-5"> [project] <message>';

/** Parse a day-of-week selector like "mon", "mon-fri", "mon,wed", "weekday", "weekend". */
function parseDows(token: string): number[] | null {
  const lower = token.toLowerCase();
  if (lower === "weekday" || lower === "weekdays") return [1, 2, 3, 4, 5];
  if (lower === "weekend" || lower === "weekends") return [0, 6];
  const out = new Set<number>();
  for (const part of lower.split(",")) {
    const range = part.split("-");
    if (range.length > 2) return null;
    const lo = DOW_INDEX[range[0]];
    if (lo === undefined) return null;
    if (range.length === 1) { out.add(lo); continue; }
    const hi = DOW_INDEX[range[1]];
    if (hi === undefined) return null;
    // Wrap around the week so "fri-mon" means Fri, Sat, Sun, Mon.
    for (let i = 0, d = lo; i < 7; i++, d = (d + 1) % 7) {
      out.add(d);
      if (d === hi) break;
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

export function parseEvery(argText: string, now: number): ParseResult {
  const trimmed = argText.trim();
  if (!trimmed) return { ok: false, error: EVERY_USAGE };

  // Quoted raw cron: /every "0 7 * * 1-5" <message>
  const quoted = /^(["'])([^"']+)\1\s*([\s\S]*)$/.exec(trimmed);
  if (quoted) {
    const expr = quoted[2].trim();
    const fields = parseCron(expr);
    if (!fields) return { ok: false, error: `Invalid cron expression: "${expr}" (need 5 fields: min hour dom month dow)` };
    if (nextCronRun(fields, now) === null) return { ok: false, error: `"${expr}" never fires within a year.` };
    return { ok: true, spec: { kind: "cron", cron: expr, describe: `cron "${expr}"` }, rest: quoted[3].trim() };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);

  const interval = INTERVAL.exec(tokens[0]);
  if (interval) {
    const n = Number(interval[1]);
    const everyMs = interval[2].toLowerCase().startsWith("h") ? n * 3_600_000 : n * 60_000;
    if (everyMs < 60_000) return { ok: false, error: "Minimum interval is 1m." };
    const unit = interval[2].toLowerCase().startsWith("h") ? "h" : "m";
    return {
      ok: true,
      spec: { kind: "interval", everyMs, describe: `every ${n}${unit}` },
      rest: tokens.slice(1).join(" "),
    };
  }

  const isDaily = /^(day|daily|everyday)$/i.test(tokens[0]);
  const dows = isDaily ? null : parseDows(tokens[0]);
  if (isDaily || dows) {
    const hm = tokens[1] ? parseHm(tokens[1]) : null;
    if (!hm) return { ok: false, error: `Missing or invalid HH:MM after "${tokens[0]}". ${EVERY_USAGE}` };
    const cron = `${hm.m} ${hm.h} * * ${dows ? dows.join(",") : "*"}`;
    const when = `${pad(hm.h)}:${pad(hm.m)}`;
    const describe = dows
      ? `${dows.map((d) => DOW_NAMES[d]).join(",")} at ${when}`
      : `daily at ${when}`;
    return { ok: true, spec: { kind: "cron", cron, describe }, rest: tokens.slice(2).join(" ") };
  }

  return { ok: false, error: `Don't understand the schedule "${tokens[0]}". ${EVERY_USAGE}` };
}

// --- flags ---

const EFFORT_FLAG = /^--effort$/i;
const MODEL_FLAG = /^--model$/i;

/**
 * Strip LEADING `--flags` off the remaining text. Only leading flags are
 * consumed so a message that happens to contain "--new" later stays intact.
 */
export function parseFlags(text: string): { flags: ScheduleFlags; rest: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const flags: ScheduleFlags = {};
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("--")) {
    const token = tokens[i];
    if (/^--(new|fresh)$/i.test(token)) { flags.fresh = true; i++; continue; }
    if (MODEL_FLAG.test(token) && tokens[i + 1]) { flags.model = tokens[i + 1]; i += 2; continue; }
    if (EFFORT_FLAG.test(token) && tokens[i + 1]) { flags.effort = tokens[i + 1]; i += 2; continue; }
    break; // unknown flag — treat as part of the message
  }
  return { flags, rest: tokens.slice(i).join(" ") };
}

// --- due selection ---

export interface DueSplit<T> {
  due: T[];
  /** Overdue by more than the grace window — the daemon was down; skip, don't fire. */
  missed: T[];
}

/**
 * Split jobs into "fire now" and "too late to fire". A job that came due while
 * the daemon was down still fires if it's within `graceMs`; older ones are
 * skipped so a week of downtime doesn't dump a backlog into your topics.
 */
export function dueJobs<T extends { nextRunAt: number; paused?: boolean }>(
  jobs: readonly T[],
  now: number,
  graceMs: number,
): DueSplit<T> {
  const due: T[] = [];
  const missed: T[] = [];
  for (const job of jobs) {
    if (job.paused) continue;
    if (job.nextRunAt > now) continue;
    (now - job.nextRunAt <= graceMs ? due : missed).push(job);
  }
  return { due, missed };
}
