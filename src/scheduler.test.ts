import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const sendToChannel = vi.fn(async (
  _chatId?: number, _topicId?: number, _path?: string, _content?: string,
): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
const updateTopicSession = vi.fn();

vi.mock("./handlers/message.js", () => ({ sendToChannel }));
vi.mock("./session-state.js", () => ({ updateTopicSession }));

const { runDueJobs, GRACE_MS, MAX_ATTEMPTS, RETRY_DELAY_MS, GATE_DEFER_MS } = await import("./scheduler.js");
const { addSchedule, loadSchedules, clearScheduleCache } = await import("./schedule-store.js");
const { saveProjects, clearConfigCache } = await import("./config.js");

type Job = import("./schedule-store.js").ScheduledJob;

const CHAT = -1001;
const TOPIC = 7;

function fakeBot() {
  const sent: Array<{ chatId: number; text: string }> = [];
  return {
    sent,
    api: { sendMessage: vi.fn(async (chatId: number, text: string) => { sent.push({ chatId, text }); }) },
  };
}

function fakePm(running = false) {
  return { isRunning: vi.fn(() => running), kill: vi.fn() };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job1",
    chatId: CHAT,
    topicId: TOPIC,
    project: "Recipes",
    message: "morning check",
    kind: "once",
    describe: "Jul 1 07:00",
    nextRunAt: 0,
    createdBy: 1,
    createdAt: 0,
    ...overrides,
  };
}

describe("runDueJobs", () => {
  let dir: string;
  const NOW = new Date(2026, 6, 1, 8, 30, 0, 0).getTime(); // Wed 2026-07-01 08:30 local

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-runner-"));
    saveProjects({ projects: [{ name: "Recipes", path: "/tmp/recipes", chatId: CHAT, topicId: TOPIC, createdAt: "" }] }, dir);
    sendToChannel.mockClear();
    sendToChannel.mockResolvedValue({ ok: true });
    updateTopicSession.mockClear();
  });

  afterEach(() => {
    clearScheduleCache();
    clearConfigCache();
    rmSync(dir, { recursive: true });
  });

  it("does nothing when nothing is due", async () => {
    addSchedule(job({ nextRunAt: NOW + 60_000 }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(loadSchedules(dir).jobs).toHaveLength(1);
  });

  it("delivers a due job, mirrors the prompt, and removes the one-shot", async () => {
    addSchedule(job({ nextRunAt: NOW - 1_000 }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);

    expect(bot.sent[0]).toEqual({ chatId: CHAT, text: "⏰ morning check" });
    expect(sendToChannel).toHaveBeenCalledOnce();
    const args = sendToChannel.mock.calls[0] as unknown as any[];
    expect(args.slice(0, 4)).toEqual([CHAT, TOPIC, "/tmp/recipes", "morning check"]);
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("rolls a cron job forward instead of removing it", async () => {
    addSchedule(job({ kind: "cron", cron: "0 9 * * *", nextRunAt: NOW - 1_000 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);

    const [saved] = loadSchedules(dir).jobs;
    expect(saved.nextRunAt).toBe(new Date(2026, 6, 1, 9, 0, 0, 0).getTime());
    expect(saved.lastRunAt).toBe(NOW);
    expect(sendToChannel).toHaveBeenCalledOnce();
  });

  it("rolls an interval job forward from now", async () => {
    addSchedule(job({ kind: "interval", everyMs: 600_000, nextRunAt: NOW - 1_000 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(loadSchedules(dir).jobs[0].nextRunAt).toBe(NOW + 600_000);
  });

  it("skips a run missed beyond the grace window without delivering", async () => {
    addSchedule(job({ kind: "cron", cron: "0 9 * * *", nextRunAt: NOW - GRACE_MS - 1 }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(bot.sent[0].text).toMatch(/Skipped a scheduled run/);
    expect(loadSchedules(dir).jobs[0].nextRunAt).toBe(new Date(2026, 6, 1, 9, 0, 0, 0).getTime());
  });

  it("drops a missed one-shot rather than firing it late", async () => {
    addSchedule(job({ nextRunAt: NOW - GRACE_MS - 1 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("clears the session id for --new and kills a running process", async () => {
    addSchedule(job({ nextRunAt: NOW - 1, flags: { fresh: true } }), dir);
    const pm = fakePm(true);
    await runDueJobs(fakeBot() as any, pm as any, NOW, dir);

    expect(updateTopicSession).toHaveBeenCalledWith(CHAT, TOPIC, {
      sessionId: "",
      projectPath: "/tmp/recipes",
      sessionCwd: undefined,
    });
    expect(pm.kill).toHaveBeenCalledWith(CHAT, TOPIC);
    expect(sendToChannel).toHaveBeenCalledOnce();
  });

  it("persists model/effort overrides before delivering", async () => {
    addSchedule(job({ nextRunAt: NOW - 1, flags: { model: "opus", effort: "high" } }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(updateTopicSession).toHaveBeenCalledWith(CHAT, TOPIC, { model: "opus", effort: "high" });
  });

  it("leaves a running process alone when there are no flags", async () => {
    addSchedule(job({ nextRunAt: NOW - 1 }), dir);
    const pm = fakePm(true);
    await runDueJobs(fakeBot() as any, pm as any, NOW, dir);
    expect(pm.kill).not.toHaveBeenCalled();
    expect(updateTopicSession).not.toHaveBeenCalled();
  });

  it("drops a job whose project no longer exists", async () => {
    addSchedule(job({ topicId: 999, nextRunAt: NOW - 1 }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);
    expect(sendToChannel).not.toHaveBeenCalled();
    expect(bot.sent[0].text).toMatch(/no longer exists/);
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("retries instead of advancing when delivery never reached Claude", async () => {
    sendToChannel.mockResolvedValueOnce({ ok: false, reason: "channels are blocked org-wide" });
    addSchedule(job({ kind: "cron", cron: "0 9 * * *", nextRunAt: NOW - 1 }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);

    const [saved] = loadSchedules(dir).jobs;
    expect(saved.nextRunAt).toBe(NOW + RETRY_DELAY_MS);   // not the next cron slot
    expect(saved.attempts).toBe(1);
    expect(saved.lastRunAt).toBeUndefined();              // never claim a run that didn't happen
    expect(bot.sent.some((m) => /Retrying in/.test(m.text))).toBe(true);
  });

  it("keeps a failed one-shot instead of deleting it", async () => {
    sendToChannel.mockResolvedValueOnce({ ok: false, reason: "Claude Code failed to start" });
    addSchedule(job({ nextRunAt: NOW - 1 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);

    const [saved] = loadSchedules(dir).jobs;
    expect(saved.nextRunAt).toBe(NOW + RETRY_DELAY_MS);
    expect(saved.attempts).toBe(1);
  });

  it("retries a thrown delivery too", async () => {
    sendToChannel.mockRejectedValueOnce(new Error("boom"));
    addSchedule(job({ nextRunAt: NOW - 1 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(loadSchedules(dir).jobs[0].attempts).toBe(1);
  });

  it("gives up after MAX_ATTEMPTS and drops the one-shot", async () => {
    sendToChannel.mockResolvedValue({ ok: false, reason: "nope" });
    addSchedule(job({ nextRunAt: NOW - 1 }), dir);

    let now = NOW;
    let lastBot = fakeBot();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      lastBot = fakeBot();
      await runDueJobs(lastBot as any, fakePm() as any, now, dir);
      now += RETRY_DELAY_MS;
    }
    expect(sendToChannel).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(lastBot.sent.some((m) => /Giving up after/.test(m.text))).toBe(true);
    expect(loadSchedules(dir).jobs).toEqual([]);

    // No further attempts — the job is gone.
    await runDueJobs(fakeBot() as any, fakePm() as any, now, dir);
    expect(sendToChannel).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("gives up without delivering when a crash left the attempts spent", async () => {
    // What a crash mid-delivery leaves behind: attempts persisted, run not advanced.
    addSchedule(job({ nextRunAt: NOW - 1, attempts: MAX_ATTEMPTS }), dir);
    const bot = fakeBot();
    await runDueJobs(bot as any, fakePm() as any, NOW, dir);

    expect(sendToChannel).not.toHaveBeenCalled();
    expect(bot.sent.some((m) => /Gave up/.test(m.text))).toBe(true);
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("resets the attempt counter once a run lands", async () => {
    sendToChannel.mockResolvedValueOnce({ ok: false, reason: "nope" });
    addSchedule(job({ kind: "cron", cron: "0 9 * * *", nextRunAt: NOW - 1 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(loadSchedules(dir).jobs[0].attempts).toBe(1);

    await runDueJobs(fakeBot() as any, fakePm() as any, NOW + RETRY_DELAY_MS, dir);
    const [saved] = loadSchedules(dir).jobs;
    expect(saved.attempts).toBe(0);
    expect(saved.lastRunAt).toBe(NOW + RETRY_DELAY_MS);
  });

  it("records lastRunAt only for runs that actually happened", async () => {
    addSchedule(job({ id: "skip", kind: "cron", cron: "0 9 * * *", nextRunAt: NOW - GRACE_MS - 1 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(loadSchedules(dir).jobs[0].lastRunAt).toBeUndefined();
  });

  it("fires several due jobs in one tick", async () => {
    addSchedule(job({ id: "a", nextRunAt: NOW - 1 }), dir);
    addSchedule(job({ id: "b", nextRunAt: NOW - 2 }), dir);
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    expect(sendToChannel).toHaveBeenCalledTimes(2);
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("mints one delivery id per run and reuses it across retry attempts", async () => {
    sendToChannel.mockResolvedValueOnce({ ok: false, reason: "the channel POST failed" });
    addSchedule(job({ nextRunAt: NOW - 1_000 }), dir);

    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir);
    const [afterFail] = loadSchedules(dir).jobs;
    expect(afterFail.deliveryId).toBeTruthy();
    const firstOpts = (sendToChannel.mock.calls[0] as unknown as any[])[7];
    expect(firstOpts).toEqual({ deliveryId: afterFail.deliveryId });

    // The retry carries the SAME id — the channel server dedupes it if the
    // first attempt actually landed (timeout-but-delivered).
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW + RETRY_DELAY_MS, dir);
    const secondOpts = (sendToChannel.mock.calls[1] as unknown as any[])[7];
    expect(secondOpts).toEqual({ deliveryId: afterFail.deliveryId });

    // Second attempt succeeded (default mock) → the one-shot is gone, id and all.
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("defers due jobs without spending attempts when the quota gate is closed", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    const cfg = loadConfig(dir);
    saveConfig({ ...cfg, defaults: { ...cfg.defaults, schedulePauseAtPercent: 95 } }, dir);
    addSchedule(job({ nextRunAt: NOW - 1_000 }), dir);
    const bot = fakeBot();
    const gate = { decide: vi.fn(async () => ({ gated: true, utilization: 97, resetsAt: null })) };
    await runDueJobs(bot as any, fakePm() as any, NOW, dir, gate as any);
    expect(sendToChannel).not.toHaveBeenCalled();
    const j = loadSchedules(dir).jobs[0];
    expect(j.nextRunAt).toBe(NOW + GATE_DEFER_MS);
    expect(j.attempts ?? 0).toBe(0);
    expect(bot.sent.some((s) => s.text.includes("deferred"))).toBe(true);
  });

  it("never consults the gate when the threshold is unset", async () => {
    addSchedule(job({ nextRunAt: NOW - 1_000 }), dir);
    const gate = { decide: vi.fn(async () => ({ gated: true })) };
    await runDueJobs(fakeBot() as any, fakePm() as any, NOW, dir, gate as any);
    expect(gate.decide).not.toHaveBeenCalled();
    expect(sendToChannel).toHaveBeenCalled();
  });
});
