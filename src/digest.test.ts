import { describe, it, expect } from "vitest";
import { DIGEST_PRESETS, presetById, digestCron, describeDigest, buildDigestJob } from "./digest.js";
import { parseCron, nextRun } from "./schedule.js";

describe("digest presets", () => {
  it("every preset has a valid 5-field cron and a real prompt", () => {
    expect(DIGEST_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const p of DIGEST_PRESETS) {
      expect(parseCron(p.defaultCron)).not.toBeNull();
      expect(p.prompt.length).toBeGreaterThan(20);
    }
  });

  it("presetById finds each preset and rejects unknowns", () => {
    for (const p of DIGEST_PRESETS) expect(presetById(p.id)).toBe(p);
    expect(presetById("nope")).toBeUndefined();
  });
});

describe("digestCron", () => {
  it("keeps the default time with no override", () => {
    expect(digestCron(presetById("morning")!, null)).toBe("0 7 * * *");
  });

  it("overrides the time but keeps the day-of-week", () => {
    expect(digestCron(presetById("weekly")!, { h: 6, m: 30 })).toBe("30 6 * * 1");
    expect(digestCron(presetById("morning")!, { h: 9, m: 15 })).toBe("15 9 * * *");
  });
});

describe("describeDigest", () => {
  it("renders daily and weekly forms with padded times", () => {
    expect(describeDigest(presetById("morning")!, "0 7 * * *")).toBe("daily at 07:00 · morning digest");
    expect(describeDigest(presetById("weekly")!, "30 6 * * 1")).toBe("Mon at 06:30 · weekly digest");
  });
});

describe("buildDigestJob", () => {
  it("produces a cron job the existing scheduler can run", () => {
    const now = new Date(2026, 7, 21, 12, 0, 0, 0).getTime();
    const preset = presetById("morning")!;
    const cron = digestCron(preset, { h: 7, m: 0 });
    const firstRun = nextRun({ kind: "cron", cron, describe: "" }, now)!;
    const job = buildDigestJob(preset, cron, { chatId: -1, topicId: 5, name: "P" }, 42, now, firstRun, "abc123");
    expect(job.kind).toBe("cron");
    expect(job.cron).toBe("0 7 * * *");
    expect(job.message).toBe(preset.prompt);
    expect(job.nextRunAt).toBeGreaterThan(now);
    expect(job.chatId).toBe(-1);
    expect(job.topicId).toBe(5);
    expect(job.project).toBe("P");
    expect(job.createdBy).toBe(42);
    expect(job.id).toBe("abc123");
  });
});
