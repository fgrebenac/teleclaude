import { describe, it, expect } from "vitest";
import {
  continueCandidates, continueRunAt, continueJobs, pickerIsStale, withoutAlreadyScheduled,
  CONTINUE_MESSAGE, PICKER_STALE_AFTER_RESET_MS,
  type CandidateProject, type TopicActivity, type ContinueCandidate,
} from "./continue-picker.js";

const NOW = new Date(2026, 6, 1, 8, 30, 0, 0).getTime();
const MIN = 60_000;

const projects: CandidateProject[] = [
  { name: "Recipes", chatId: -100, topicId: 1 },
  { name: "Atlas", chatId: -100, topicId: 2 },
  { name: "Notes", chatId: -200, topicId: 3 },
  { name: "Garden", topicId: 4 }, // legacy, no chatId
];

/** Activity lookup from a {topicId: state} map. */
function lookup(map: Record<number, TopicActivity>) {
  return (_chatId: number, topicId: number) => map[topicId];
}

describe("continueCandidates", () => {
  it("offers running projects and recently active ones", () => {
    const items = continueCandidates(projects, lookup({
      1: { running: true },
      2: { lastActiveAt: NOW - 2 * 3_600_000 },
      3: { lastActiveAt: NOW - 30 * 3_600_000 }, // stale
    }), NOW);
    expect(items.map((i) => i.name)).toEqual(["Recipes", "Atlas"]);
  });

  it("skips a project with no known chat", () => {
    const items = continueCandidates(projects, lookup({ 4: { running: true } }), NOW);
    expect(items).toEqual([]);
  });

  it("ticks what was working when the limit hit, leaves older ones unticked", () => {
    const items = continueCandidates(projects, lookup({
      1: { running: true },
      2: { lastActiveAt: NOW - 5 * MIN },
      3: { lastActiveAt: NOW - 3 * 3_600_000 },
    }), NOW);
    expect(items.map((i) => [i.name, i.preselected])).toEqual([
      ["Recipes", true],   // running
      ["Atlas", true],      // active 5 min ago
      ["Notes", false],      // active 3 h ago — offered, not ticked
    ]);
  });

  it("puts running projects first, then most recently active", () => {
    const items = continueCandidates(projects, lookup({
      1: { lastActiveAt: NOW - 60 * MIN },
      2: { lastActiveAt: NOW - 5 * MIN },
      3: { running: true, lastActiveAt: NOW - 120 * MIN },
    }), NOW);
    expect(items.map((i) => i.name)).toEqual(["Notes", "Atlas", "Recipes"]);
  });

  it("treats a session with no timestamp as stale unless it's running", () => {
    expect(continueCandidates(projects, lookup({ 1: {} }), NOW)).toEqual([]);
    expect(continueCandidates(projects, lookup({ 1: { running: true } }), NOW)).toHaveLength(1);
  });

  it("caps the list so the keyboard stays usable", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, chatId: -100, topicId: i }));
    const activity = Object.fromEntries(many.map((_, i) => [i, { running: true }]));
    expect(continueCandidates(many, lookup(activity), NOW)).toHaveLength(8);
    expect(continueCandidates(many, lookup(activity), NOW, { max: 3 })).toHaveLength(3);
  });

  it("honours custom windows", () => {
    const activity = lookup({ 1: { lastActiveAt: NOW - 90 * MIN } });
    expect(continueCandidates(projects, activity, NOW, { activeWithinMs: 60 * MIN })).toEqual([]);
    const items = continueCandidates(projects, activity, NOW, { preselectWithinMs: 2 * 3_600_000 });
    expect(items[0].preselected).toBe(true);
  });

  it("returns nothing when nothing was active", () => {
    expect(continueCandidates(projects, lookup({}), NOW)).toEqual([]);
  });
});

describe("continueRunAt", () => {
  it("fires just after the bucket resets", () => {
    const resets = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(continueRunAt(resets, NOW)).toBe(NOW + 2 * 3_600_000 + MIN);
  });

  it("stays in the future for a reset time already passed", () => {
    expect(continueRunAt(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe(NOW + MIN);
  });

  it("falls back to a short delay when the reset time is missing or junk", () => {
    expect(continueRunAt(null, NOW)).toBe(NOW + MIN);
    expect(continueRunAt("nonsense", NOW)).toBe(NOW + MIN);
  });
});

describe("continueJobs", () => {
  const selected: ContinueCandidate[] = [
    { chatId: -100, topicId: 1, name: "Recipes", running: true, preselected: true },
    { chatId: -200, topicId: 3, name: "Notes", running: false, preselected: false },
  ];

  it("builds one one-shot job per project, all at the same time", () => {
    let n = 0;
    const runAt = NOW + 3_600_000;
    const jobs = continueJobs(selected, runAt, 123456789, NOW, () => `id${++n}`);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.id)).toEqual(["id1", "id2"]);
    expect(jobs.every((j) => j.kind === "once" && j.nextRunAt === runAt && j.runAt === runAt)).toBe(true);
    expect(jobs.every((j) => j.message === CONTINUE_MESSAGE)).toBe(true);
    expect(jobs.map((j) => [j.chatId, j.topicId])).toEqual([[-100, 1], [-200, 3]]);
    expect(jobs[0].createdBy).toBe(123456789);
    expect(jobs[0].describe).toContain("after quota reset");
  });

  it("continues the existing session — no fresh-session or model flags", () => {
    const [job] = continueJobs(selected.slice(0, 1), NOW + 1000, 1, NOW, () => "x");
    expect(job.flags).toBeUndefined();
  });

  it("returns nothing for an empty selection", () => {
    expect(continueJobs([], NOW, 1, NOW, () => "x")).toEqual([]);
  });
});

describe("pickerIsStale", () => {
  const resets = new Date(NOW).toISOString();

  it("is usable before and just after the reset", () => {
    expect(pickerIsStale(resets, NOW - 60 * MIN)).toBe(false);
    expect(pickerIsStale(resets, NOW + PICKER_STALE_AFTER_RESET_MS)).toBe(false);
  });

  it("is stale once the limit has been back for a while", () => {
    expect(pickerIsStale(resets, NOW + PICKER_STALE_AFTER_RESET_MS + 1)).toBe(true);
    expect(pickerIsStale(resets, NOW + 30 * 24 * 3_600_000)).toBe(true);
  });

  it("lets an unknown reset time through", () => {
    expect(pickerIsStale(null, NOW)).toBe(false);
    expect(pickerIsStale("nonsense", NOW)).toBe(false);
  });
});

describe("withoutAlreadyScheduled", () => {
  const runAt = NOW + 3_600_000;
  const a = { chatId: -100, topicId: 1, name: "Recipes" };
  const b = { chatId: -200, topicId: 3, name: "Notes" };

  it("keeps everything when nothing is scheduled", () => {
    expect(withoutAlreadyScheduled([a, b], [], runAt)).toEqual({ fresh: [a, b], duplicates: [] });
  });

  it("drops a project that already has a continue run at the same moment", () => {
    const existing = [{ chatId: -100, topicId: 1, message: CONTINUE_MESSAGE, nextRunAt: runAt + 60_000 }];
    expect(withoutAlreadyScheduled([a, b], existing, runAt)).toEqual({ fresh: [b], duplicates: [a] });
  });

  it("ignores a different message, topic, or a far-off run", () => {
    const existing = [
      { chatId: -100, topicId: 1, message: "something else", nextRunAt: runAt },
      { chatId: -100, topicId: 9, message: CONTINUE_MESSAGE, nextRunAt: runAt },
      { chatId: -100, topicId: 1, message: CONTINUE_MESSAGE, nextRunAt: runAt + 6 * 60_000 },
    ];
    expect(withoutAlreadyScheduled([a], existing, runAt).fresh).toEqual([a]);
  });
});
