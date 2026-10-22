import { describe, it, expect } from "vitest";
import {
  parseAt, parseEvery, parseFlags, parseCron, nextCronRun, nextRun, dueJobs, fmtLocal, fmtIn,
} from "./schedule.js";

/** Local wall-clock helper so tests read the way a user types times. */
function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

// Wed 2026-07-01 08:30 local
const NOW = local(2026, 7, 1, 8, 30);

describe("parseAt", () => {
  it("takes HH:MM later today", () => {
    const r = parseAt("14:00 recipes run the check", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.kind).toBe("once");
    expect(r.spec.runAt).toBe(local(2026, 7, 1, 14, 0));
    expect(r.rest).toBe("recipes run the check");
  });

  it("rolls HH:MM already past to tomorrow", () => {
    const r = parseAt("07:00 do it", NOW);
    expect(r.ok && r.spec.runAt).toBe(local(2026, 7, 2, 7, 0));
  });

  it("treats the exact current minute as tomorrow rather than firing instantly", () => {
    const r = parseAt("08:30 do it", NOW);
    expect(r.ok && r.spec.runAt).toBe(local(2026, 7, 2, 8, 30));
  });

  it("accepts tomorrow HH:MM", () => {
    const r = parseAt("tomorrow 06:15 morning report", NOW);
    expect(r.ok && r.spec.runAt).toBe(local(2026, 7, 2, 6, 15));
    expect(r.ok && r.rest).toBe("morning report");
  });

  it("accepts an explicit date", () => {
    const r = parseAt("2026-08-02 07:00 atlas check CI", NOW);
    expect(r.ok && r.spec.runAt).toBe(local(2026, 8, 2, 7, 0));
    expect(r.ok && r.rest).toBe("atlas check CI");
  });

  it("rejects a date in the past", () => {
    const r = parseAt("2026-06-01 07:00 too late", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/in the past/);
  });

  it("accepts relative delays", () => {
    expect(parseAt("+30m ping", NOW)).toMatchObject({ ok: true, spec: { runAt: NOW + 30 * 60_000 }, rest: "ping" });
    expect(parseAt("+2h ping", NOW)).toMatchObject({ ok: true, spec: { runAt: NOW + 2 * 3_600_000 } });
    expect(parseAt("+1d ping", NOW)).toMatchObject({ ok: true, spec: { runAt: NOW + 86_400_000 } });
  });

  it("rejects an impossible date instead of silently rolling it over", () => {
    // new Date(2026, 1, 30) normalizes to Mar 2 — must not be accepted.
    const r = parseAt("2026-02-30 07:00 x", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No such date/);
    expect(parseAt("2026-13-01 07:00 x", NOW).ok).toBe(false);
    expect(parseAt("2026-04-31 07:00 x", NOW).ok).toBe(false);
  });

  it("still accepts a real leap day", () => {
    expect(parseAt("2028-02-29 07:00 x", NOW)).toMatchObject({ ok: true });
  });

  it("rejects nonsense and bad times", () => {
    expect(parseAt("", NOW).ok).toBe(false);
    expect(parseAt("soonish do it", NOW).ok).toBe(false);
    expect(parseAt("25:00 do it", NOW).ok).toBe(false);
    expect(parseAt("2026-08-02 do it", NOW).ok).toBe(false);
  });
});

describe("parseEvery", () => {
  it("builds a daily cron", () => {
    const r = parseEvery("day 07:00 recipes morning check", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toMatchObject({ kind: "cron", cron: "0 7 * * *", describe: "daily at 07:00" });
    expect(r.rest).toBe("recipes morning check");
  });

  it("builds weekday ranges and lists", () => {
    expect(parseEvery("mon-fri 09:30 x", NOW)).toMatchObject({ ok: true, spec: { cron: "30 9 * * 1,2,3,4,5" } });
    expect(parseEvery("mon,wed 09:30 x", NOW)).toMatchObject({ ok: true, spec: { cron: "30 9 * * 1,3" } });
    expect(parseEvery("weekday 09:30 x", NOW)).toMatchObject({ ok: true, spec: { cron: "30 9 * * 1,2,3,4,5" } });
    expect(parseEvery("weekend 10:00 x", NOW)).toMatchObject({ ok: true, spec: { cron: "0 10 * * 0,6" } });
  });

  it("wraps a range across the weekend", () => {
    expect(parseEvery("fri-mon 08:00 x", NOW)).toMatchObject({ ok: true, spec: { cron: "0 8 * * 0,1,5,6" } });
  });

  it("builds fixed intervals", () => {
    expect(parseEvery("30m poll the deploy", NOW)).toMatchObject({
      ok: true, spec: { kind: "interval", everyMs: 1_800_000, describe: "every 30m" }, rest: "poll the deploy",
    });
    expect(parseEvery("2h x", NOW)).toMatchObject({ ok: true, spec: { everyMs: 7_200_000 } });
  });

  it("rejects a sub-minute interval", () => {
    expect(parseEvery("0m x", NOW).ok).toBe(false);
  });

  it("accepts a quoted raw cron", () => {
    const r = parseEvery('"0 7 * * 1-5" weekday standup', NOW);
    expect(r).toMatchObject({ ok: true, spec: { kind: "cron", cron: "0 7 * * 1-5" }, rest: "weekday standup" });
  });

  it("rejects an invalid cron and one that never fires", () => {
    expect(parseEvery('"0 7 * *" x', NOW).ok).toBe(false);
    expect(parseEvery('"0 7 99 * *" x', NOW).ok).toBe(false);
    expect(parseEvery('"0 7 30 2 *" x', NOW).ok).toBe(false); // Feb 30
  });

  it("rejects an unknown spec and a missing time", () => {
    expect(parseEvery("blursday 09:00 x", NOW).ok).toBe(false);
    expect(parseEvery("mon x", NOW).ok).toBe(false);
    expect(parseEvery("", NOW).ok).toBe(false);
  });
});

describe("parseCron / nextCronRun", () => {
  it("parses steps, lists and ranges", () => {
    const f = parseCron("*/15 9-17 * * 1-5")!;
    expect([...f.minutes]).toEqual([0, 15, 30, 45]);
    expect([...f.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(f.doms).toBeNull();
    expect([...f.dows!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps cron's day 7 to Sunday", () => {
    expect([...parseCron("0 0 * * 7")!.dows!]).toEqual([0]);
  });

  it("returns the next matching minute, strictly after `from`", () => {
    const f = parseCron("30 8 * * *")!; // exactly NOW
    expect(nextCronRun(f, NOW)).toBe(local(2026, 7, 2, 8, 30));
  });

  it("skips to the next allowed weekday", () => {
    // Wed 2026-07-01 → next Mon is 2026-07-06
    expect(nextCronRun(parseCron("0 9 * * 1")!, NOW)).toBe(local(2026, 7, 6, 9, 0));
  });

  it("honours cron's dom-OR-dow rule", () => {
    // 15th of the month OR any Monday, whichever comes first.
    expect(nextCronRun(parseCron("0 9 15 * 1")!, NOW)).toBe(local(2026, 7, 6, 9, 0));
  });

  it("crosses a month boundary", () => {
    expect(nextCronRun(parseCron("0 9 1 * *")!, local(2026, 7, 1, 10, 0))).toBe(local(2026, 8, 1, 9, 0));
  });

  it("returns null for an impossible date", () => {
    expect(nextCronRun(parseCron("0 9 30 2 *")!, NOW)).toBeNull();
  });
});

describe("nextRun", () => {
  it("returns a future one-shot and null for a past one", () => {
    expect(nextRun({ kind: "once", runAt: NOW + 1000, describe: "" }, NOW)).toBe(NOW + 1000);
    expect(nextRun({ kind: "once", runAt: NOW - 1000, describe: "" }, NOW)).toBeNull();
  });

  it("advances an interval from the current time (no drift catch-up)", () => {
    expect(nextRun({ kind: "interval", everyMs: 600_000, describe: "" }, NOW)).toBe(NOW + 600_000);
  });

  it("computes the next cron run", () => {
    expect(nextRun({ kind: "cron", cron: "0 9 * * *", describe: "" }, NOW)).toBe(local(2026, 7, 1, 9, 0));
  });
});

describe("parseFlags", () => {
  it("consumes leading flags only", () => {
    expect(parseFlags("--new --model opus --effort high run tests")).toEqual({
      flags: { fresh: true, model: "opus", effort: "high" },
      rest: "run tests",
    });
  });

  it("leaves a message containing -- alone", () => {
    expect(parseFlags("run npm test -- --new")).toEqual({ flags: {}, rest: "run npm test -- --new" });
  });

  it("stops at an unknown flag", () => {
    expect(parseFlags("--bogus do it")).toEqual({ flags: {}, rest: "--bogus do it" });
  });

  it("ignores a value-less flag", () => {
    expect(parseFlags("--model")).toEqual({ flags: {}, rest: "--model" });
  });
});

describe("dueJobs", () => {
  const grace = 30 * 60_000;

  it("fires jobs at or past their time", () => {
    const { due, missed } = dueJobs([{ nextRunAt: NOW }, { nextRunAt: NOW + 1 }], NOW, grace);
    expect(due).toHaveLength(1);
    expect(missed).toHaveLength(0);
  });

  it("fires a job missed inside the grace window", () => {
    expect(dueJobs([{ nextRunAt: NOW - grace }], NOW, grace).due).toHaveLength(1);
  });

  it("skips a job overdue beyond the grace window", () => {
    const { due, missed } = dueJobs([{ nextRunAt: NOW - grace - 1 }], NOW, grace);
    expect(due).toHaveLength(0);
    expect(missed).toHaveLength(1);
  });

  it("ignores paused jobs entirely", () => {
    expect(dueJobs([{ nextRunAt: NOW - 1, paused: true }], NOW, grace)).toEqual({ due: [], missed: [] });
  });
});

describe("formatting", () => {
  it("formats a local time without the year when it matches", () => {
    expect(fmtLocal(local(2026, 8, 2, 7, 5), NOW)).toBe("Aug 2 07:05");
    expect(fmtLocal(local(2027, 1, 2, 7, 5), NOW)).toBe("Jan 2 2027 07:05");
  });

  it("formats relative time", () => {
    expect(fmtIn(NOW + 45 * 60_000, NOW)).toBe("in 45m");
    expect(fmtIn(NOW + 3 * 3_600_000 + 600_000, NOW)).toBe("in 3h 10m");
    expect(fmtIn(NOW + 2 * 86_400_000, NOW)).toBe("in 2d 0h");
    expect(fmtIn(NOW - 1, NOW)).toBe("overdue");
  });
});
