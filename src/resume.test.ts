import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Same realpath-first FAKE_HOME as sessions.test.ts: on macOS TMPDIR is under a
// symlink (/var/folders -> /private/var/folders), and projectDirName() (via
// sessionHomes) realpath-resolves a project root before dash-joining it into a
// `~/.claude/projects/<name>` directory name — a raw, un-resolved FAKE_HOME
// would dash-join to a DIFFERENT name than what sessionHomes computes.
const FAKE_HOME = vi.hoisted(() => {
  const rfs = require("fs");
  const base = process.env.TMPDIR?.replace(/\/$/, "") ?? "/tmp";
  let realBase = base;
  try { realBase = rfs.realpathSync(base); } catch { /* use as-is */ }
  return `${realBase}/teleclaude-resume-test-${process.pid}`;
});
vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => FAKE_HOME,
}));

import { resumeSession } from "./handlers/resume.js";
import { loadSessionState, getTopicSession, updateTopicSession } from "./session-state.js";
import { clearSessionHomesCache } from "./sessions.js";

const CHAT = -100123;
const TOPIC = 5;

function fakePm(running: boolean) {
  return {
    kill: vi.fn(),
    spawn: vi.fn(() => 8801),
    getPid: vi.fn(() => (running ? 99999 : undefined)),
  } as any;
}

describe("resumeSession (worktree-aware)", () => {
  const ROOT = join(FAKE_HOME, "work", "teleclaude");
  const ROOT_DIR = join(FAKE_HOME, ".claude", "projects", ROOT.replace(/[^a-zA-Z0-9]/g, "-"));
  const WORKTREE = join(ROOT, ".claude", "worktrees", "sdd-phase0-fixes");
  const WORKTREE_DIR = join(FAKE_HOME, ".claude", "projects", WORKTREE.replace(/[^a-zA-Z0-9]/g, "-"));
  const ROOT_SESSION = "aaaaaaaa-0000-0000-0000-000000000000";
  const WORKTREE_SESSION = "bbbbbbbb-0000-0000-0000-000000000000";

  let stateDir: string;

  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true });
    mkdirSync(WORKTREE, { recursive: true });
    mkdirSync(ROOT_DIR, { recursive: true });
    mkdirSync(WORKTREE_DIR, { recursive: true });
    writeFileSync(join(ROOT_DIR, `${ROOT_SESSION}.jsonl`), `${JSON.stringify({ type: "user", cwd: ROOT })}\n`);
    writeFileSync(join(WORKTREE_DIR, `${WORKTREE_SESSION}.jsonl`), `${JSON.stringify({ type: "user", cwd: WORKTREE })}\n`);
  });
  afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

  beforeEach(() => {
    clearSessionHomesCache();
    stateDir = mkdtempSync(join(tmpdir(), "teleclaude-resume-state-"));
    loadSessionState(stateDir);
  });

  it("resumes a root-homed session with no cwd override, clearing any prior sessionCwd", () => {
    // Persist a stale sessionCwd first (as if a previous /resume had put this
    // topic into a worktree) so the assertion below is a real "it got
    // cleared", not just "it stayed undefined".
    updateTopicSession(CHAT, TOPIC, { sessionId: "", projectPath: ROOT, sessionCwd: join(ROOT, ".claude", "worktrees", "stale") });
    const pm = fakePm(false);
    return resumeSession(pm, CHAT, TOPIC, ROOT, ROOT_SESSION).then((outcome) => {
      expect(outcome).toEqual({ ok: true, subpath: undefined });
      expect(pm.spawn).toHaveBeenCalledWith(CHAT, TOPIC, ROOT, expect.objectContaining({ sessionId: ROOT_SESSION, cwd: undefined }));
      expect(getTopicSession(CHAT, TOPIC)?.sessionCwd).toBeUndefined();
    });
  });

  it("resumes a worktree-homed session, persisting its cwd", async () => {
    const pm = fakePm(false);
    const outcome = await resumeSession(pm, CHAT, TOPIC, ROOT, WORKTREE_SESSION);
    expect(outcome).toEqual({ ok: true, subpath: join(".claude", "worktrees", "sdd-phase0-fixes") });
    expect(pm.spawn).toHaveBeenCalledWith(CHAT, TOPIC, ROOT, expect.objectContaining({ sessionId: WORKTREE_SESSION, cwd: WORKTREE }));
    expect(getTopicSession(CHAT, TOPIC)?.sessionCwd).toBe(WORKTREE);
  });

  it("reports not-found for an unknown session id", async () => {
    const pm = fakePm(false);
    const outcome = await resumeSession(pm, CHAT, TOPIC, ROOT, "no-such-session");
    expect(outcome).toEqual({ ok: false, reason: "not-found" });
    expect(pm.kill).not.toHaveBeenCalled();
  });

  it("refuses a worktree-homed session whose directory was deleted", async () => {
    rmSync(WORKTREE, { recursive: true, force: true });
    try {
      const pm = fakePm(false);
      const outcome = await resumeSession(pm, CHAT, TOPIC, ROOT, WORKTREE_SESSION);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok && outcome.reason === "cwd-missing") {
        expect(outcome.message).toContain(WORKTREE);
      } else {
        throw new Error(`expected cwd-missing, got ${JSON.stringify(outcome)}`);
      }
      expect(pm.kill).not.toHaveBeenCalled();
      expect(pm.spawn).not.toHaveBeenCalled();
    } finally {
      mkdirSync(WORKTREE, { recursive: true }); // restore for any later test in this file
    }
  });
});
