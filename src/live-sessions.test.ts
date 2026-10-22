import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { findLiveSession, isSessionLiveElsewhere, resumeGuardDecision } from "./live-sessions.js";

const DIR = "/tmp/teleclaude-test-live-sessions";
const SID = "35133a33-da1c-4664-8110-19d27c9518af";

function writeEntry(pid: number, sessionId = SID): void {
  writeFileSync(join(DIR, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/tmp/proj", name: "x" }));
}

describe("findLiveSession", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("finds a matching entry and reports it alive via the injected check", () => {
    writeEntry(111);
    const match = findLiveSession(SID, { baseDir: DIR, isPidAlive: (pid) => pid === 111 });
    expect(match).toEqual({ pid: 111, alive: true });
  });

  it("reports a stale entry (dead pid) as not alive", () => {
    writeEntry(222);
    const match = findLiveSession(SID, { baseDir: DIR, isPidAlive: () => false });
    expect(match).toEqual({ pid: 222, alive: false });
  });

  it("returns null when no entry matches the session id", () => {
    writeEntry(333, "some-other-session");
    expect(findLiveSession(SID, { baseDir: DIR })).toBeNull();
  });

  it("returns null when the registry directory doesn't exist, never throws", () => {
    expect(findLiveSession(SID, { baseDir: join(DIR, "nope") })).toBeNull();
  });

  it("ignores non-pid filenames and unparseable entries", () => {
    writeFileSync(join(DIR, "not-a-pid.json"), "{}");
    writeFileSync(join(DIR, "444.json"), "{ bad json");
    writeEntry(555);
    const match = findLiveSession(SID, { baseDir: DIR, isPidAlive: () => true });
    expect(match).toEqual({ pid: 555, alive: true });
  });

  it("prefers an alive entry over a stale dead-pid entry for the same session id, regardless of readdir order", () => {
    // Two registry files for the SAME session id: one stale (dead pid), one
    // live. readdirSync order isn't guaranteed to put either first, so this
    // must pass whichever pid sorts first lexically — 666 then 777, and the
    // reverse (777 then 666) below.
    writeEntry(666); // dead
    writeEntry(777); // alive
    const isPidAlive = (pid: number) => pid === 777;
    expect(findLiveSession(SID, { baseDir: DIR, isPidAlive })).toEqual({ pid: 777, alive: true });
  });

  it("prefers an alive entry over a stale dead-pid entry the other way round too", () => {
    writeEntry(777); // alive
    writeEntry(666); // dead
    const isPidAlive = (pid: number) => pid === 777;
    expect(findLiveSession(SID, { baseDir: DIR, isPidAlive })).toEqual({ pid: 777, alive: true });
  });
});

describe("isSessionLiveElsewhere", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("is false when the live pid IS the caller's own process", () => {
    writeEntry(111);
    expect(isSessionLiveElsewhere(SID, 111, { baseDir: DIR, isPidAlive: () => true })).toBe(false);
  });

  it("is true when alive in a different pid", () => {
    writeEntry(111);
    expect(isSessionLiveElsewhere(SID, 222, { baseDir: DIR, isPidAlive: () => true })).toBe(true);
  });

  it("is false when the matching entry is stale (dead pid)", () => {
    writeEntry(111);
    expect(isSessionLiveElsewhere(SID, 222, { baseDir: DIR, isPidAlive: () => false })).toBe(false);
  });

  it("is false when there's no entry at all", () => {
    expect(isSessionLiveElsewhere(SID, 222, { baseDir: DIR })).toBe(false);
  });
});

describe("resumeGuardDecision", () => {
  it("allows when there's no live entry", () => {
    expect(resumeGuardDecision(null, 42)).toEqual({ allow: true });
  });

  it("allows a stale (dead) entry", () => {
    expect(resumeGuardDecision({ pid: 99, alive: false }, 42)).toEqual({ allow: true });
  });

  it("allows when the live pid IS the topic's own current process", () => {
    expect(resumeGuardDecision({ pid: 42, alive: true }, 42)).toEqual({ allow: true });
  });

  it("refuses when alive in a DIFFERENT pid, with a reason naming it", () => {
    const d = resumeGuardDecision({ pid: 99, alive: true }, 42);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("99");
  });

  it("refuses even when ownPid is undefined (no process running here) — anyone else alive counts", () => {
    const d = resumeGuardDecision({ pid: 99, alive: true }, undefined);
    expect(d.allow).toBe(false);
  });
});
