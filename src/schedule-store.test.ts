import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addSchedule, listSchedules, findSchedule, removeSchedule, updateSchedule,
  loadSchedules, newJobId, resolveJobRef, clearScheduleCache, type ScheduledJob,
} from "./schedule-store.js";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: newJobId(),
    chatId: -100,
    topicId: 5,
    project: "Recipes",
    message: "morning check",
    kind: "cron",
    cron: "0 7 * * *",
    describe: "daily at 07:00",
    nextRunAt: 1_000,
    createdBy: 123456789,
    createdAt: 0,
    ...overrides,
  };
}

describe("schedule-store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-sched-"));
  });

  afterEach(() => {
    clearScheduleCache();
    rmSync(dir, { recursive: true });
  });

  it("starts empty and round-trips a job", () => {
    expect(loadSchedules(dir).jobs).toEqual([]);
    const j = job();
    addSchedule(j, dir);
    clearScheduleCache();
    expect(loadSchedules(dir).jobs).toEqual([j]);
  });

  it("issues distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newJobId()));
    expect(ids.size).toBe(50);
  });

  it("lists a chat's jobs soonest first, and filters by topic", () => {
    addSchedule(job({ id: "aaa", nextRunAt: 3_000 }), dir);
    addSchedule(job({ id: "bbb", nextRunAt: 1_000 }), dir);
    addSchedule(job({ id: "ccc", topicId: 9, nextRunAt: 2_000 }), dir);
    addSchedule(job({ id: "ddd", chatId: -200, nextRunAt: 500 }), dir);

    expect(listSchedules(-100, undefined, dir).map((j) => j.id)).toEqual(["bbb", "ccc", "aaa"]);
    expect(listSchedules(-100, 5, dir).map((j) => j.id)).toEqual(["bbb", "aaa"]);
    expect(listSchedules(-200, undefined, dir).map((j) => j.id)).toEqual(["ddd"]);
  });

  it("never reuses an id already in the store", () => {
    // 6 hex chars is plenty, but a duplicate would make the wrong job cancellable.
    for (let i = 0; i < 40; i++) addSchedule(job({ id: newJobId(dir) }), dir);
    const ids = loadSchedules(dir).jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds by exact id and by prefix, scoped to the chat", () => {
    addSchedule(job({ id: "abc123" }), dir);
    addSchedule(job({ id: "zzz999", chatId: -200 }), dir);
    expect(findSchedule(-100, "abc123", dir)?.id).toBe("abc123");
    expect(findSchedule(-100, "abc", dir)?.id).toBe("abc123");
    expect(findSchedule(-100, "zzz999", dir)).toBeUndefined();
    expect(findSchedule(-100, "nope", dir)).toBeUndefined();
  });

  it("removes a job and reports what was removed", () => {
    addSchedule(job({ id: "abc123" }), dir);
    expect(removeSchedule("abc123", dir)?.project).toBe("Recipes");
    clearScheduleCache();
    expect(loadSchedules(dir).jobs).toEqual([]);
    expect(removeSchedule("abc123", dir)).toBeUndefined();
  });

  it("updates fields in place", () => {
    addSchedule(job({ id: "abc123" }), dir);
    updateSchedule("abc123", { nextRunAt: 9_999, lastRunAt: 42 }, dir);
    clearScheduleCache();
    const [saved] = loadSchedules(dir).jobs;
    expect(saved.nextRunAt).toBe(9_999);
    expect(saved.lastRunAt).toBe(42);
    updateSchedule("missing", { nextRunAt: 1 }, dir); // no throw
  });

  it("refuses an ambiguous prefix instead of guessing", () => {
    const jobs = [job({ id: "ab1111" }), job({ id: "ab2222" }), job({ id: "cd3333" })];
    expect(resolveJobRef(jobs, "ab")).toMatchObject({ status: "ambiguous" });
    expect(resolveJobRef(jobs, "ab1")).toMatchObject({ status: "ok", job: { id: "ab1111" } });
    expect(resolveJobRef(jobs, "cd3333")).toMatchObject({ status: "ok", job: { id: "cd3333" } });
    expect(resolveJobRef(jobs, "zz")).toEqual({ status: "unknown" });
    // An exact id wins even when it prefixes another.
    expect(resolveJobRef([job({ id: "ab" }), job({ id: "ab99" })], "ab")).toMatchObject({ status: "ok", job: { id: "ab" } });
  });

  it("tolerates a corrupt file and preserves the original", () => {
    writeFileSync(join(dir, "schedules.json"), "{ this is not json");
    expect(loadSchedules(dir).jobs).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith("schedules.json.corrupt-"))).toBe(true);
  });

  it("tolerates a file with the wrong shape", () => {
    writeFileSync(join(dir, "schedules.json"), JSON.stringify({ jobs: "nope" }));
    expect(loadSchedules(dir).jobs).toEqual([]);
  });
});
