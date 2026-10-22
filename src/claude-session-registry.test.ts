import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readLiveSession, readLiveSessionName, pollSessionName } from "./claude-session-registry.js";

const DIR = "/tmp/teleclaude-test-registry";

/** A real entry, copied from ~/.claude/sessions on 2.1.234. */
function writeEntry(pid: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(DIR, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: "35133a33-da1c-4664-8110-19d27c9518af",
    cwd: "/Users/x/Private/Todo",
    startedAt: 1786642218656,
    version: "2.1.231",
    kind: "interactive",
    name: "todo-c6",
    nameSource: "derived",
    status: "idle",
    ...extra,
  }));
}

describe("claude-session-registry", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("reads a live session entry", () => {
    writeEntry(63493);
    const entry = readLiveSession(63493, DIR);
    expect(entry?.sessionId).toBe("35133a33-da1c-4664-8110-19d27c9518af");
    expect(entry?.name).toBe("todo-c6");
    expect(readLiveSessionName(63493, DIR)).toBe("todo-c6");
  });

  it("treats a missing or unparseable file as unknown, never an error", () => {
    expect(readLiveSession(1, DIR)).toBeNull();
    expect(readLiveSessionName(1, DIR)).toBeUndefined();
    writeFileSync(join(DIR, "2.json"), "{not json");
    expect(readLiveSession(2, DIR)).toBeNull();
    // A registry that changes shape must degrade to "unknown", not throw —
    // this is an undocumented implementation detail of Claude Code.
    writeFileSync(join(DIR, "3.json"), "null");
    expect(readLiveSession(3, DIR)).toBeNull();
    writeFileSync(join(DIR, "4.json"), JSON.stringify({ pid: 4 }));
    expect(readLiveSessionName(4, DIR)).toBeUndefined();
  });

  it("ignores an empty name", () => {
    writeEntry(5, { name: "" });
    expect(readLiveSessionName(5, DIR)).toBeUndefined();
  });

  it("polls until the name changes", async () => {
    writeEntry(10);
    setTimeout(() => writeEntry(10, { name: "api work" }), 60);
    const name = await pollSessionName(10, (n) => n !== "todo-c6", {
      timeoutMs: 2000, intervalMs: 20, baseDir: DIR,
    });
    expect(name).toBe("api work");
  });

  it("returns the last name read when the timeout expires", async () => {
    writeEntry(11);
    const name = await pollSessionName(11, (n) => n === "never happens", {
      timeoutMs: 60, intervalMs: 20, baseDir: DIR,
    });
    // Unchanged — the caller decides that means "unconfirmed".
    expect(name).toBe("todo-c6");
  });

  it("returns undefined when there is no entry at all", async () => {
    const name = await pollSessionName(12, (n) => n !== undefined, {
      timeoutMs: 60, intervalMs: 20, baseDir: DIR,
    });
    expect(name).toBeUndefined();
  });
});
