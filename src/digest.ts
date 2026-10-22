import type { ScheduledJob } from "./schedule-store.js";

/**
 * Digest presets: UX sugar over /every. A confirmed preset becomes an ordinary
 * cron job in schedules.json, so every existing delivery/retry/grace mechanism
 * in scheduler.ts applies unchanged, and /schedules manages it like any job.
 */

export interface DigestPreset {
  id: string;
  /** Button label shown in the /digest picker. */
  label: string;
  /** 5-field cron with the default time-of-day baked in. */
  defaultCron: string;
  /** The prompt delivered into the topic's session on each run. */
  prompt: string;
}

export const DIGEST_PRESETS: readonly DigestPreset[] = [
  {
    id: "morning",
    label: "☀️ Morning briefing (daily 07:00)",
    defaultCron: "0 7 * * *",
    prompt: "Morning briefing: summarize what happened since yesterday — git log since yesterday, "
      + "any open PRs or failing CI you can check from here, uncommitted work, and what I should "
      + "tackle first today. Keep it tight and phone-readable.",
  },
  {
    id: "eod",
    label: "🌙 End-of-day recap (daily 18:00)",
    defaultCron: "0 18 * * *",
    prompt: "End-of-day recap: summarize today's changes (git log since this morning), anything "
      + "uncommitted or half-done, and a short plan for tomorrow.",
  },
  {
    id: "weekly",
    label: "📅 Weekly review (Mon 08:00)",
    defaultCron: "0 8 * * 1",
    prompt: "Weekly review: summarize the last 7 days — git log for the past week, what shipped, "
      + "what stalled, and the top 3 priorities for this week.",
  },
];

export function presetById(id: string): DigestPreset | undefined {
  return DIGEST_PRESETS.find((p) => p.id === id);
}

/** Apply an optional HH:MM override to a preset's cron, keeping its day-of-week. */
export function digestCron(preset: DigestPreset, hm: { h: number; m: number } | null): string {
  if (!hm) return preset.defaultCron;
  const f = preset.defaultCron.trim().split(/\s+/);
  return `${hm.m} ${hm.h} ${f[2]} ${f[3]} ${f[4]}`;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human description for /schedules listings, e.g. "daily at 07:00 · morning digest". */
export function describeDigest(preset: DigestPreset, cron: string): string {
  const [min, hour, , , dow] = cron.trim().split(/\s+/);
  const when = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const days = dow === "*" ? "daily" : DOW_NAMES[Number(dow) % 7] ?? dow;
  return `${days} at ${when} · ${preset.id} digest`;
}

/** One ordinary cron ScheduledJob — the caller supplies id and first nextRunAt. */
export function buildDigestJob(
  preset: DigestPreset,
  cron: string,
  target: { chatId: number; topicId: number; name: string },
  createdBy: number,
  now: number,
  nextRunAt: number,
  id: string,
): ScheduledJob {
  return {
    id,
    chatId: target.chatId,
    topicId: target.topicId,
    project: target.name,
    message: preset.prompt,
    kind: "cron",
    cron,
    describe: describeDigest(preset, cron),
    nextRunAt,
    createdBy,
    createdAt: now,
  };
}
