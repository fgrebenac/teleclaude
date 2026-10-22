import { describe, it, expect } from "vitest";
import { ProcessManager, type ProcessEventName, resolveSpawnCwd } from "./processes.js";

const CHAT = -100123;

describe("ProcessManager", () => {
  it("event names are a closed union — a typo fails the compiler", () => {
    // Compile-time assertion (same pattern as tool-schemas.test.ts): the
    // expect-error directive below fails tsc if the union ever widens back to string.
    const ok: ProcessEventName = "done";
    // @ts-expect-error — "doen" is not an emitted event name
    const bad: ProcessEventName = "doen";
    void bad;
    expect(ok).toBe("done");
  });

  it("reports not running for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.isRunning(CHAT, 123)).toBe(false);
  });

  it("returns undefined port for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.getPort(CHAT, 123)).toBeUndefined();
  });

  it("assigns incrementing ports", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.nextPort()).toBe(8801);
    expect(pm.nextPort()).toBe(8802);
    expect(pm.nextPort()).toBe(8803);
  });

  it("status returns empty for fresh manager", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.status()).toEqual([]);
  });

  it("returns default model for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.getModel(CHAT, 123)).toBe("sonnet");
  });

  it("returns auto, not bypass, as the permission mode for an unknown topic", () => {
    // The old default here was bypass=true, i.e. --dangerously-skip-permissions
    // for any topic with no persisted choice. Auto is the default now.
    const pm = new ProcessManager("fake-token");
    expect(pm.getPermissionMode(CHAT, 123)).toBe("auto");
  });

  it("returns undefined sessionId for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.getSessionId(CHAT, 123)).toBeUndefined();
  });

  it("fires event handler on callback", () => {
    const pm = new ProcessManager("fake-token");
    const events: any[] = [];
    pm.setEventHandler((e) => events.push(e));
    pm.handleCallback(CHAT, 123, "done");
    expect(events).toEqual([{ chatId: CHAT, topicId: 123, event: "done" }]);
  });

  it("beginTurn returns undefined for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.beginTurn(CHAT, 123)).toBeUndefined();
  });

  it("getCurrentTurnToken is undefined for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.getCurrentTurnToken(CHAT, 123)).toBeUndefined();
  });

  it("interruptTurn reports not-running for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.interruptTurn(CHAT, 123)).toBe("not-running");
  });

  it("hasCancelPending is false for unknown topic", () => {
    const pm = new ProcessManager("fake-token");
    expect(pm.hasCancelPending(CHAT, 123)).toBe(false);
  });
});

describe("resolveSpawnCwd", () => {
  const PROJECT = "/tmp/teleclaude-fake-project";
  const WORKTREE = "/tmp/teleclaude-fake-project/.claude/worktrees/foo";
  // Real existsSync (the default dirExists) would return false for these fake
  // paths — tests that aren't specifically exercising the deleted-directory
  // fallback pass a dirExists stub that says everything exists, so they keep
  // testing only what they say they test.
  const dirExistsTrue = () => true;

  it("uses the project root when no cwd override is given", () => {
    expect(resolveSpawnCwd(undefined, PROJECT, undefined, () => true)).toEqual({
      cwd: PROJECT,
      sessionId: undefined,
    });
  });

  it("uses the override cwd when a transcript exists there and the directory is present", () => {
    const exists = (id: string, cwd: string) => cwd === WORKTREE && id === "abc";
    expect(resolveSpawnCwd(WORKTREE, PROJECT, "abc", exists, dirExistsTrue)).toEqual({
      cwd: WORKTREE,
      sessionId: "abc",
    });
  });

  it("falls back to the project root and drops the session id when the transcript is missing at the resolved cwd", () => {
    const exists = () => false;
    expect(resolveSpawnCwd(WORKTREE, PROJECT, "abc", exists, dirExistsTrue)).toEqual({
      cwd: PROJECT,
      sessionId: undefined,
    });
  });

  it("never calls the transcript existence check when there is no sessionId to validate", () => {
    const exists = () => { throw new Error("should not be called"); };
    expect(resolveSpawnCwd(WORKTREE, PROJECT, undefined, exists, dirExistsTrue)).toEqual({
      cwd: WORKTREE,
      sessionId: undefined,
    });
  });

  // Regression coverage for a live-crash finding: transcripts live under
  // ~/.claude/projects/<dashed-cwd>, entirely outside the worktree itself, so
  // `git worktree remove` leaves the transcript "existing" at a cwd that no
  // longer exists on disk. Without the dirExists check, that cwd would be
  // handed straight to pty.spawn, which throws ENOENT synchronously.
  it("falls back to the project root BEFORE the transcript check when the requested cwd no longer exists on disk, and drops the session id if no transcript exists at the root either", () => {
    const exists = (id: string, cwd: string) => cwd === WORKTREE && id === "abc"; // "exists" only at the now-deleted worktree
    const dirExists = (p: string) => p !== WORKTREE; // the worktree dir is gone; the project root is not
    expect(resolveSpawnCwd(WORKTREE, PROJECT, "abc", exists, dirExists)).toEqual({
      cwd: PROJECT,
      sessionId: undefined,
    });
  });

  it("falls back to the project root when the requested cwd is gone, and resumes there when a transcript exists AT the root", () => {
    const exists = (id: string, cwd: string) => cwd === PROJECT && id === "abc"; // transcript also exists at root
    const dirExists = (p: string) => p !== WORKTREE;
    expect(resolveSpawnCwd(WORKTREE, PROJECT, "abc", exists, dirExists)).toEqual({
      cwd: PROJECT,
      sessionId: "abc",
    });
  });
});
