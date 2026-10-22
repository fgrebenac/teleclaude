import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadSessionState,
  getTopicSession,
  setTopicSession,
  updateTopicSession,
  clearTopicSession,
  isRecentlyActive,
  spawnSettingsFor,
  autoSpawnDecision,
} from "./session-state.js";

const CHAT = -100999;

let dir: string;

beforeEach(() => {
  // Isolated store per test — the suite must NEVER touch the operator's live
  // ~/.teleclaude/sessions.json (npm version runs the tests on every release,
  // possibly while the daemon is running).
  dir = mkdtempSync(join(tmpdir(), "teleclaude-session-state-"));
  loadSessionState(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("session-state isolation", () => {
  it("writes to the directory given to loadSessionState, not the real ~/.teleclaude", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    const onDisk = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8"));
    expect(onDisk[`${CHAT}:12345`].sessionId).toBe("abc-session");
  });

  it("refuses to write the real ~/.teleclaude under vitest", () => {
    loadSessionState(); // no dir → the real default path
    expect(() => setTopicSession(CHAT, 1, "x", "/tmp/x")).toThrow(/refusing to write/);
  });

  it("under vitest, never mutates a corrupt sessions.json found at the resolved real default dir", () => {
    // Reproduces the guard condition (VITEST + no dir → resolves to the "real"
    // default dir) without ever touching the operator's actual ~/.teleclaude:
    // HOME is stubbed to a throwaway dir for the duration of this test only,
    // so `defaultDir()` resolves there instead. If loadSessionState()'s
    // corrupt-preserve rename fired here, it would prove the same hazard
    // would fire against the real home directory outside tests.
    const fakeHome = mkdtempSync(join(tmpdir(), "teleclaude-fake-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const fakeStateDir = join(fakeHome, ".teleclaude");
      mkdirSync(fakeStateDir, { recursive: true });
      const file = join(fakeStateDir, "sessions.json");
      writeFileSync(file, "{ not valid json");

      loadSessionState(); // no dir → resolves to (stubbed) defaultDir(), under VITEST

      expect(getTopicSession(CHAT, 1)).toBeUndefined();
      // The guard must skip the read/rename entirely — file untouched, no sidecar.
      expect(readFileSync(file, "utf-8")).toBe("{ not valid json");
      expect(readdirSync(fakeStateDir).filter((f) => f.includes("corrupt"))).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("on a missing sessions.json, loads empty state without creating a backup", () => {
    // dir is freshly mkdtemp'd — no sessions.json exists yet.
    loadSessionState(dir);
    expect(getTopicSession(CHAT, 1)).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes("corrupt"))).toHaveLength(0);
  });

  it("on a corrupt sessions.json, preserves it as .corrupt-<ts> and loads empty state", () => {
    const file = join(dir, "sessions.json");
    writeFileSync(file, "{ not valid json");
    loadSessionState(dir);
    expect(getTopicSession(CHAT, 1)).toBeUndefined();
    const backups = readdirSync(dir).filter((f) => f.startsWith("sessions.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), "utf-8")).toBe("{ not valid json");
    expect(() => statSync(file)).toThrow();
  });

  it("reloads persisted state from disk", () => {
    setTopicSession(CHAT, 7, "persisted", "/tmp/p");
    loadSessionState(dir); // fresh load, same dir
    expect(getTopicSession(CHAT, 7)!.sessionId).toBe("persisted");
  });
});

describe("session-state", () => {
  it("returns undefined for unknown topic", () => {
    expect(getTopicSession(CHAT, 99999)).toBeUndefined();
  });

  it("sets and gets topic session", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    const result = getTopicSession(CHAT, 12345);
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe("abc-session");
    expect(result!.projectPath).toBe("/tmp/test");
  });

  it("updates topic session partially", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    updateTopicSession(CHAT, 12345, { bypass: false, model: "opus" });
    const result = getTopicSession(CHAT, 12345);
    expect(result!.sessionId).toBe("abc-session");
    expect(result!.bypass).toBe(false);
    expect(result!.model).toBe("opus");
  });

  it("clears topic session", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    clearTopicSession(CHAT, 12345);
    expect(getTopicSession(CHAT, 12345)).toBeUndefined();
  });

  it("toggles the receipts flag like any other persisted setting (/receipts)", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    expect(getTopicSession(CHAT, 12345)!.receipts).toBeUndefined(); // default off

    updateTopicSession(CHAT, 12345, { receipts: true });
    expect(getTopicSession(CHAT, 12345)!.receipts).toBe(true);

    updateTopicSession(CHAT, 12345, { receipts: false });
    expect(getTopicSession(CHAT, 12345)!.receipts).toBe(false);
  });

  it("persists the liveView mode across a reload, like any other setting (/live)", () => {
    setTopicSession(CHAT, 12345, "abc-session", "/tmp/test");
    expect(getTopicSession(CHAT, 12345)!.liveView).toBeUndefined(); // default (summary) is implicit

    updateTopicSession(CHAT, 12345, { liveView: "full" });
    expect(getTopicSession(CHAT, 12345)!.liveView).toBe("full");

    // Round-trip through disk (same store loadSessionState(dir) pointed at).
    loadSessionState(dir);
    expect(getTopicSession(CHAT, 12345)!.liveView).toBe("full");

    updateTopicSession(CHAT, 12345, { liveView: "off" });
    expect(getTopicSession(CHAT, 12345)!.liveView).toBe("off");
  });

  it("isolates the same topic id across different chats", () => {
    setTopicSession(-111, 2, "mine", "/p/mine");
    setTopicSession(-222, 2, "hers", "/p/hers");
    expect(getTopicSession(-111, 2)!.sessionId).toBe("mine");
    expect(getTopicSession(-222, 2)!.sessionId).toBe("hers");
  });
});

describe("isRecentlyActive", () => {
  const now = 1_000_000_000;
  const within = 48 * 60 * 60 * 1000;

  it("treats a missing timestamp as active (legacy entries)", () => {
    expect(isRecentlyActive(undefined, now, within)).toBe(true);
  });

  it("is active within the window", () => {
    expect(isRecentlyActive(now - 60_000, now, within)).toBe(true);
    expect(isRecentlyActive(now - within + 1, now, within)).toBe(true);
  });

  it("is inactive past the window", () => {
    expect(isRecentlyActive(now - within, now, within)).toBe(false);
    expect(isRecentlyActive(now - within - 1, now, within)).toBe(false);
  });
});

describe("spawnSettingsFor", () => {
  it("fills in the defaults a spawn needs", () => {
    expect(spawnSettingsFor(undefined)).toEqual({
      sessionId: undefined,
      model: "sonnet",
      permissionMode: "auto",
      doneNotify: false,
      effort: undefined,
      name: undefined,
      liveView: "summary",
    });
  });

  it("carries the persisted liveView mode, so a respawn keeps it", () => {
    expect(spawnSettingsFor({ sessionId: "abc", projectPath: "/tmp/p", liveView: "full" }).liveView).toBe("full");
    expect(spawnSettingsFor({ sessionId: "abc", projectPath: "/tmp/p", liveView: "off" }).liveView).toBe("off");
  });

  it("defaults liveView to summary when absent or corrupted", () => {
    expect(spawnSettingsFor({ sessionId: "abc", projectPath: "/tmp/p" }).liveView).toBe("summary");
    // Untrusted disk state (sessions.json is read via a corrupt-tolerant JSON
    // loader, not validated against the type) — a garbage value must not
    // reach the channel server as-is.
    expect(spawnSettingsFor({ sessionId: "abc", projectPath: "/tmp/p", liveView: "bogus" as never }).liveView).toBe("summary");
  });

  it("carries the persisted session name, so a respawn keeps it", () => {
    const settings = spawnSettingsFor({
      sessionId: "abc", projectPath: "/tmp/p", model: "opus", effort: "high", name: "quota alerts",
    });
    expect(settings.name).toBe("quota alerts");
    expect(settings.model).toBe("opus");
    expect(settings.effort).toBe("high");
    expect(settings.sessionId).toBe("abc");
  });

  it("treats a blanked session id as a fresh session", () => {
    // /new writes sessionId: "" rather than deleting the entry — that must not
    // become `--resume ""`.
    expect(spawnSettingsFor({ sessionId: "", projectPath: "/tmp/p" }).sessionId).toBeUndefined();
  });

  it("honours the legacy bypass boolean", () => {
    expect(spawnSettingsFor({ sessionId: "", projectPath: "/tmp/p", bypass: true }).permissionMode).toBe("bypass");
  });

  it("lets overrides win, including clearing a value", () => {
    const saved = { sessionId: "abc", projectPath: "/tmp/p", effort: "high", name: "old" };
    expect(spawnSettingsFor(saved, { model: "haiku", effort: undefined }).model).toBe("haiku");
    expect(spawnSettingsFor(saved, { effort: undefined }).effort).toBeUndefined();
    expect(spawnSettingsFor(saved, { sessionId: undefined }).sessionId).toBeUndefined();
    // A name in the override replaces the persisted one (that's `/new <name>`).
    expect(spawnSettingsFor(saved, { name: "new" }).name).toBe("new");
    // A liveView in the override replaces the persisted/default one.
    expect(spawnSettingsFor(saved, { liveView: "off" }).liveView).toBe("off");
  });

  it("defaults cwd to the persisted sessionCwd, and an override wins (including clearing it)", () => {
    const saved = { sessionId: "abc", projectPath: "/tmp/p", sessionCwd: "/tmp/p/.claude/worktrees/foo" };
    expect(spawnSettingsFor(saved).cwd).toBe("/tmp/p/.claude/worktrees/foo");
    expect(spawnSettingsFor(saved, { cwd: undefined }).cwd).toBeUndefined();
    expect(spawnSettingsFor(saved, { cwd: "/tmp/p/other" }).cwd).toBe("/tmp/p/other");
    expect(spawnSettingsFor(undefined).cwd).toBeUndefined();
  });
});

describe("autoSpawnDecision", () => {
  const now = 1_000_000_000;
  const recentMs = 48 * 60 * 60 * 1000;
  const project = { name: "P", path: "/tmp/p", chatId: -1, topicId: 5, createdAt: "2026-01-01" };
  const saved = { sessionId: "abc", projectPath: "/tmp/p", lastActiveAt: now - 60_000 };

  it("approves a live project with a recent persisted session", () => {
    expect(autoSpawnDecision({ project, projectPathExists: true, saved, now, recentMs }))
      .toEqual({ spawn: true });
  });

  it("refuses when the project was deleted in the stagger window", () => {
    const d = autoSpawnDecision({ project: undefined, projectPathExists: false, saved, now, recentMs });
    expect(d.spawn).toBe(false);
  });

  it("refuses when the project directory is gone — pty.spawn would throw", () => {
    const d = autoSpawnDecision({ project, projectPathExists: false, saved, now, recentMs });
    expect(d.spawn).toBe(false);
    if (!d.spawn) expect(d.reason).toContain("/tmp/p");
  });

  it("refuses when the session was cleared since boot (/new in the window — /stop leaves sessionId set)", () => {
    expect(autoSpawnDecision({ project, projectPathExists: true, saved: undefined, now, recentMs }).spawn).toBe(false);
    expect(autoSpawnDecision({
      project, projectPathExists: true,
      saved: { sessionId: "", projectPath: "/tmp/p" }, now, recentMs,
    }).spawn).toBe(false);
  });

  it("refuses when no longer recently active", () => {
    const stale = { ...saved, lastActiveAt: now - recentMs - 1 };
    expect(autoSpawnDecision({ project, projectPathExists: true, saved: stale, now, recentMs }).spawn).toBe(false);
  });
});
