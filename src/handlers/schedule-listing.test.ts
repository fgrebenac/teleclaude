import { describe, it, expect } from "vitest";
import { renderScheduleListing } from "./schedule.js";
import type { ScheduledJob } from "../schedule-store.js";

const NOW = Date.now();

function heavyJob(i: number): ScheduledJob {
  return {
    id: `a1b2c${i}`,
    chatId: -1001,
    topicId: i,
    project: "web-store",
    message: "x".repeat(200),
    kind: "cron",
    cron: "*/15 9-17 * * 1-5",
    describe: 'cron "*/15 9-17 * * 1-5"',
    nextRunAt: NOW + i * 3_600_000,
    flags: { fresh: true, model: "claude-opus-5[1m]", effort: "high" },
    createdBy: 1,
    createdAt: 0,
  };
}

describe("renderScheduleListing", () => {
  it("keeps a heavy listing inside Telegram's message limit", () => {
    const jobs = Array.from({ length: 20 }, (_, i) => heavyJob(i));
    const { lines, shown } = renderScheduleListing(jobs, NOW);
    expect(lines.join("\n").length).toBeLessThan(4096);
    expect(shown.length).toBeLessThan(jobs.length);          // truncated to fit
    expect(lines.at(-1)).toMatch(/more — cancel some to see them/);
  });

  it("shows everything when it fits", () => {
    const jobs = [heavyJob(1), heavyJob(2)];
    const { lines, shown } = renderScheduleListing(jobs, NOW);
    expect(shown).toHaveLength(2);
    expect(lines.join("\n")).not.toMatch(/more —/);
  });

  it("respects the count cap as well as the character budget", () => {
    const light: ScheduledJob[] = Array.from({ length: 30 }, (_, i) => ({
      ...heavyJob(i), message: "hi", flags: undefined, describe: "daily at 07:00",
    }));
    const { shown } = renderScheduleListing(light, NOW, 100_000, 20);
    expect(shown).toHaveLength(20);
  });
});
