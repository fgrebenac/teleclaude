import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const sessions: Record<number, { lastActiveAt?: number }> = {};
vi.mock("../session-state.js", () => ({
  getTopicSession: (_chatId: number, topicId: number) => sessions[topicId],
}));

const { buildContinueOffer, handleContinueCallback, clearContinuePickers } = await import("./continue.js");
const { loadSchedules, clearScheduleCache } = await import("../schedule-store.js");
const { saveProjects, clearConfigCache } = await import("../config.js");

const CHAT_A = -100;
const CHAT_B = -200;
const OWNER = 123456789;

function fakePm(running: number[] = []) {
  return { isRunning: (_chatId: number, topicId: number) => running.includes(topicId) } as any;
}

function fakeBot() {
  return {
    api: {
      editMessageReplyMarkup: vi.fn(async (_chatId: number, _msgId: number, _other?: any) => {}),
      editMessageText: vi.fn(async (_chatId: number, _msgId: number, _text?: string, _other?: any) => {}),
      sendMessage: vi.fn(async (_chatId: number, _text?: string) => {}),
    },
  };
}

function fakeCtx() {
  return {
    from: { id: OWNER },
    answerCallbackQuery: vi.fn(async () => {}),
    callbackQuery: { message: { chat: { id: OWNER }, message_id: 42, text: "🔴 Claude quota exhausted" } },
  };
}

/** Labels of the project rows (the last row is the action row). */
function rowLabels(keyboard: any[][]): string[] {
  return keyboard.slice(0, -1).map((row) => row[0].text);
}

describe("continue picker", () => {
  let dir: string;
  // Real wall clock: the handler stamps runAt with Date.now(), so a fake "now"
  // here would land in the past and get clamped.
  const NOW = Date.now();
  const RESETS_AT = new Date(NOW + 2 * 3_600_000).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-continue-"));
    saveProjects({
      projects: [
        { name: "Recipes", path: "/p/n", chatId: CHAT_A, topicId: 1, createdAt: "" },
        { name: "Atlas", path: "/p/i", chatId: CHAT_B, topicId: 2, createdAt: "" },
      ],
    }, dir);
    for (const k of Object.keys(sessions)) delete sessions[Number(k)];
  });

  afterEach(() => {
    clearContinuePickers();
    clearScheduleCache();
    clearConfigCache();
    rmSync(dir, { recursive: true });
  });

  it("offers nothing when no project was recently active", () => {
    expect(buildContinueOffer(fakePm(), RESETS_AT, NOW, dir)).toBeUndefined();
  });

  it("ticks a running project and offers a recent one unticked", () => {
    sessions[2] = { lastActiveAt: NOW - 3 * 3_600_000 };
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;

    expect(rowLabels(offer.keyboard)).toEqual(["✅ Recipes 🟢", "⬜ Atlas"]);
    expect(offer.keyboard.at(-1)!.map((b: any) => b.callback_data)).toEqual([
      `cont:go:${offer.token}`, `cont:x:${offer.token}`,
    ]);
  });

  it("toggles a row without scheduling anything", async () => {
    sessions[2] = { lastActiveAt: NOW - 3 * 3_600_000 };
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    const bot = fakeBot();
    const ctx = fakeCtx();

    await handleContinueCallback(bot as any, ctx as any, `cont:t:${offer.token}:1`, dir);

    const updated = bot.api.editMessageReplyMarkup.mock.calls[0][2] as any;
    expect(rowLabels(updated.reply_markup.inline_keyboard)).toEqual(["✅ Recipes 🟢", "✅ Atlas"]);
    expect(loadSchedules(dir).jobs).toEqual([]);

    // …and back off again
    await handleContinueCallback(bot as any, ctx as any, `cont:t:${offer.token}:1`, dir);
    const reverted = bot.api.editMessageReplyMarkup.mock.calls[1][2] as any;
    expect(rowLabels(reverted.reply_markup.inline_keyboard)).toEqual(["✅ Recipes 🟢", "⬜ Atlas"]);
  });

  it("schedules the ticked projects for just after the reset", async () => {
    sessions[2] = { lastActiveAt: NOW - 3 * 3_600_000 };
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    const bot = fakeBot();

    await handleContinueCallback(bot as any, fakeCtx() as any, `cont:go:${offer.token}`, dir);

    const jobs = loadSchedules(dir).jobs;
    expect(jobs).toHaveLength(1); // only the ticked one
    expect(jobs[0]).toMatchObject({
      project: "Recipes", chatId: CHAT_A, topicId: 1, kind: "once", message: "Continue working", createdBy: OWNER,
    });
    // reset + 1 min buffer, allowing for the wall clock inside the handler
    const expected = Date.parse(RESETS_AT) + 60_000;
    expect(Math.abs(jobs[0].nextRunAt - expected)).toBeLessThan(5_000);

    const [, , text] = bot.api.editMessageText.mock.calls[0] as any[];
    expect(text).toContain("🔴 Claude quota exhausted");
    expect(text).toContain('"Continue working" scheduled');
    expect(text).toContain(`/unschedule ${jobs[0].id}`);
  });

  it("schedules every ticked project across different groups", async () => {
    sessions[2] = { lastActiveAt: NOW - 60_000 };
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:go:${offer.token}`, dir);

    const jobs = loadSchedules(dir).jobs;
    expect(jobs.map((j) => [j.project, j.chatId, j.topicId])).toEqual([
      ["Recipes", CHAT_A, 1],
      ["Atlas", CHAT_B, 2],
    ]);
    expect(new Set(jobs.map((j) => j.nextRunAt)).size).toBe(1); // same moment
  });

  it("refuses to schedule an empty selection", async () => {
    sessions[1] = { lastActiveAt: NOW - 3 * 3_600_000 }; // offered, not ticked
    const offer = buildContinueOffer(fakePm(), RESETS_AT, NOW, dir)!;
    const ctx = fakeCtx();

    await handleContinueCallback(fakeBot() as any, ctx as any, `cont:go:${offer.token}`, dir);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Pick at least one project first" });
    expect(loadSchedules(dir).jobs).toEqual([]);
  });

  it("consumes the picker so a double tap can't double-schedule", async () => {
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:go:${offer.token}`, dir);
    const ctx = fakeCtx();
    await handleContinueCallback(fakeBot() as any, ctx as any, `cont:go:${offer.token}`, dir);

    expect(loadSchedules(dir).jobs).toHaveLength(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "This picker expired — use /at to schedule instead." });
  });

  it("dismisses without scheduling", async () => {
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    const bot = fakeBot();
    await handleContinueCallback(bot as any, fakeCtx() as any, `cont:x:${offer.token}`, dir);

    expect(loadSchedules(dir).jobs).toEqual([]);
    const [, , , other] = bot.api.editMessageText.mock.calls[0] as any[];
    expect(other.reply_markup.inline_keyboard).toEqual([]);
  });

  it("clears the keyboard for an unknown token", async () => {
    const bot = fakeBot();
    const ctx = fakeCtx();
    await handleContinueCallback(bot as any, ctx as any, "cont:t:deadbe:0", dir);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "This picker expired — use /at to schedule instead." });
    expect(bot.api.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it("rejects an out-of-range project index", async () => {
    const offer = buildContinueOffer(fakePm([1]), RESETS_AT, NOW, dir)!;
    const ctx = fakeCtx();
    await handleContinueCallback(fakeBot() as any, ctx as any, `cont:t:${offer.token}:9`, dir);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Unknown project" });
  });
});

describe("continue picker guards", () => {
  let dir: string;
  const NOW = Date.now();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-continue2-"));
    saveProjects({
      projects: [
        { name: "Recipes", path: "/p/n", chatId: CHAT_A, topicId: 1, createdAt: "" },
        { name: "Atlas", path: "/p/i", chatId: CHAT_B, topicId: 2, createdAt: "" },
      ],
    }, dir);
    for (const k of Object.keys(sessions)) delete sessions[Number(k)];
  });

  afterEach(() => {
    clearContinuePickers();
    clearScheduleCache();
    clearConfigCache();
    rmSync(dir, { recursive: true });
  });

  it("refuses to schedule from an alert whose limit already reset", async () => {
    // Reset was hours ago — pressing now would start work out of nowhere.
    const stale = new Date(NOW - 3 * 3_600_000).toISOString();
    const offer = buildContinueOffer(fakePm([1]), stale, NOW, dir)!;
    const bot = fakeBot();
    const ctx = fakeCtx();

    await handleContinueCallback(bot as any, ctx as any, `cont:go:${offer.token}`, dir);

    expect(loadSchedules(dir).jobs).toEqual([]);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "That limit already reset — just message the project, or use /at." });
    const [, , text] = bot.api.editMessageText.mock.calls[0] as any[];
    expect(text).toMatch(/Too late to schedule/);
  });

  it("doesn't queue the same continue run twice when two owners confirm", async () => {
    const resets = new Date(NOW + 2 * 3_600_000).toISOString();
    const first = buildContinueOffer(fakePm([1]), resets, NOW, dir)!;
    const second = buildContinueOffer(fakePm([1]), resets, NOW, dir)!;

    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:go:${first.token}`, dir);
    expect(loadSchedules(dir).jobs).toHaveLength(1);

    const ctx = fakeCtx();
    await handleContinueCallback(fakeBot() as any, ctx as any, `cont:go:${second.token}`, dir);

    expect(loadSchedules(dir).jobs).toHaveLength(1); // still one
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already scheduled for this reset" });
  });

  it("still schedules a project the other owner didn't tick", async () => {
    sessions[2] = { lastActiveAt: NOW - 60_000 };
    const resets = new Date(NOW + 2 * 3_600_000).toISOString();
    const first = buildContinueOffer(fakePm([1]), resets, NOW, dir)!;
    const second = buildContinueOffer(fakePm([1]), resets, NOW, dir)!;

    // First owner unticks Atlas, confirms only Recipes.
    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:t:${first.token}:1`, dir);
    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:go:${first.token}`, dir);
    expect(loadSchedules(dir).jobs.map((j) => j.project)).toEqual(["Recipes"]);

    // Second owner confirms both — only the missing one is added.
    await handleContinueCallback(fakeBot() as any, fakeCtx() as any, `cont:go:${second.token}`, dir);
    expect(loadSchedules(dir).jobs.map((j) => j.project)).toEqual(["Recipes", "Atlas"]);
  });
});
