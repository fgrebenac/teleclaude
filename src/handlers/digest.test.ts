import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleDigestCallback } from "./schedule.js";
import { addSchedule, loadSchedules, clearScheduleCache, type ScheduledJob } from "../schedule-store.js";
import { saveProjects, clearConfigCache } from "../config.js";
import { presetById } from "../digest.js";

const CHAT = -100;
const TOPIC = 7;
const OWNER = 123456789;

function fakeCtx() {
  return {
    from: { id: OWNER },
    answerCallbackQuery: vi.fn(async () => {}),
    api: { editMessageText: vi.fn(async () => {}) },
    callbackQuery: { message: { chat: { id: CHAT }, message_thread_id: TOPIC, message_id: 99 } },
  };
}

describe("/digest button", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-digest-"));
    saveProjects({
      projects: [{ name: "Recipes", path: "/p/n", chatId: CHAT, topicId: TOPIC, createdAt: "" }],
    }, dir);
  });

  afterEach(() => {
    clearScheduleCache();
    clearConfigCache();
    rmSync(dir, { recursive: true });
  });

  it("persists the preset as an ordinary cron job through the shared schedule store", async () => {
    const ctx = fakeCtx();
    await handleDigestCallback(ctx as any, "digest:morning:0700", dir);

    const jobs = loadSchedules(dir).jobs;
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job).toMatchObject({
      chatId: CHAT, topicId: TOPIC, project: "Recipes", kind: "cron", cron: "0 7 * * *",
      message: presetById("morning")!.prompt, createdBy: OWNER,
    });
    expect(job.nextRunAt).toBeGreaterThan(Date.now());

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Scheduled" });
    const [chatId, msgId, text, opts] = ctx.api.editMessageText.mock.calls[0] as any[];
    expect(chatId).toBe(CHAT);
    expect(msgId).toBe(99);
    expect(text).toContain(job.id);
    expect(opts.reply_markup.inline_keyboard).toEqual([[{ text: "❌ Cancel this", callback_data: `sched:del:${job.id}` }]]);
  });

  it("bakes a time override into the cron while keeping the preset's day-of-week", async () => {
    await handleDigestCallback(fakeCtx() as any, "digest:weekly:0630", dir);
    const job = loadSchedules(dir).jobs[0];
    expect(job.cron).toBe("30 6 * * 1");
  });

  it("refuses a duplicate: same topic, same prompt, same cron", async () => {
    await handleDigestCallback(fakeCtx() as any, "digest:morning:0700", dir);
    const ctx = fakeCtx();
    await handleDigestCallback(ctx as any, "digest:morning:0700", dir);

    expect(loadSchedules(dir).jobs).toHaveLength(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Already scheduled") }));
  });

  it("does not treat different presets or different times as duplicates", async () => {
    await handleDigestCallback(fakeCtx() as any, "digest:morning:0700", dir);
    await handleDigestCallback(fakeCtx() as any, "digest:eod:1800", dir);
    await handleDigestCallback(fakeCtx() as any, "digest:morning:0900", dir);
    expect(loadSchedules(dir).jobs).toHaveLength(3);
  });

  it("answers gracefully for a malformed or unknown preset id", async () => {
    const ctx = fakeCtx();
    await handleDigestCallback(ctx as any, "digest:bogus:0700", dir);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Expired — run /digest again" });
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("answers gracefully when the project is gone", async () => {
    clearConfigCache();
    const otherDir = mkdtempSync(join(tmpdir(), "teleclaude-digest-empty-"));
    const ctx = fakeCtx();
    await handleDigestCallback(ctx as any, "digest:morning:0700", otherDir);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Project not found" });
    rmSync(otherDir, { recursive: true });
  });

  it("respects the per-chat schedule cap", async () => {
    for (let i = 0; i < 50; i++) {
      const job: ScheduledJob = {
        id: `job${i}`, chatId: CHAT, topicId: TOPIC, project: "Recipes", message: `m${i}`,
        kind: "cron", cron: "0 0 * * *", describe: "daily", nextRunAt: Date.now() + 1000,
        createdBy: OWNER, createdAt: Date.now(),
      };
      addSchedule(job, dir);
    }
    const ctx = fakeCtx();
    await handleDigestCallback(ctx as any, "digest:morning:0700", dir);
    expect(loadSchedules(dir).jobs).toHaveLength(50);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Too many schedules") }));
  });
});
