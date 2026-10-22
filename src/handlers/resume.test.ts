import { describe, it, expect, vi, beforeEach } from "vitest";
import { resumeSession } from "./resume.js";
import { resolveSessionHome } from "../sessions.js";
import { findLiveSession, resumeGuardDecision } from "../live-sessions.js";
import type { ProcessManager } from "../processes.js";

// resumeSession's only impure dependencies besides ProcessManager:
// resolveSessionHome reads ~/.claude/projects/<dir> from the live filesystem,
// and live-sessions.ts is exercised directly (with fixtures) in
// live-sessions.test.ts. Mock both here so this file tests only
// resumeSession's own wiring — not-found / live-elsewhere / cwd-missing /
// kill+respawn — not the filesystem. resolveSessionHome now also doubles as
// the not-found gate (a null return means the session exists nowhere), so it
// defaults to `{ cwd: PATH }` — "found, homed at the project root", which
// resumeCwdDecision treats as needing no cwd override — the common case
// these tests otherwise don't care about; worktree-cwd behavior is covered
// by the filesystem-backed src/resume.test.ts instead.
vi.mock("../sessions.js", () => ({ resolveSessionHome: vi.fn(() => ({ cwd: "/tmp/proj" })) }));
vi.mock("../live-sessions.js", () => ({ findLiveSession: vi.fn(), resumeGuardDecision: vi.fn() }));
vi.mock("../session-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-state.js")>();
  return { ...actual, getTopicSession: vi.fn(() => undefined), updateTopicSession: vi.fn() };
});

const CHAT = -100;
const TOPIC = 5;
const PATH = "/tmp/proj";
const SID = "35133a33-da1c-4664-8110-19d27c9518af";

function fakePm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getPid: vi.fn().mockReturnValue(42),
    kill: vi.fn(),
    spawn: vi.fn(),
    ...overrides,
  } as unknown as ProcessManager;
}

describe("resumeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears call history, not a mockReturnValue set by an
    // earlier test — re-arm the "found at project root" default so the
    // not-found test's override can't leak into the rest of the suite.
    vi.mocked(resolveSessionHome).mockReturnValue({ cwd: PATH });
  });

  it("returns not-found when resolveSessionHome finds the session nowhere", async () => {
    vi.mocked(resolveSessionHome).mockReturnValue(null);
    const pm = fakePm();
    const result = await resumeSession(pm, CHAT, TOPIC, PATH, SID);
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(pm.kill).not.toHaveBeenCalled();
  });

  it("refuses, and does NOT kill/spawn, when the guard says the session is live elsewhere", async () => {
    vi.mocked(findLiveSession).mockReturnValue({ pid: 99, alive: true });
    vi.mocked(resumeGuardDecision).mockReturnValue({ allow: false, reason: "session is open in another Claude process (pid 99)" });
    const pm = fakePm();
    const result = await resumeSession(pm, CHAT, TOPIC, PATH, SID);
    expect(result).toEqual({
      ok: false,
      reason: "live-elsewhere",
      pid: 99,
      detail: "session is open in another Claude process (pid 99)",
    });
    expect(pm.kill).not.toHaveBeenCalled();
    expect(pm.spawn).not.toHaveBeenCalled();
  });

  it("kills and respawns when the guard allows it", async () => {
    vi.mocked(findLiveSession).mockReturnValue(null);
    vi.mocked(resumeGuardDecision).mockReturnValue({ allow: true });
    const pm = fakePm();
    const result = await resumeSession(pm, CHAT, TOPIC, PATH, SID);
    expect(result).toEqual({ ok: true });
    expect(pm.kill).toHaveBeenCalledWith(CHAT, TOPIC);
    expect(pm.spawn).toHaveBeenCalledTimes(1);
  });

  it("passes the topic's own pid (ProcessManager.getPid) to the guard, not just the match", async () => {
    vi.mocked(findLiveSession).mockReturnValue({ pid: 42, alive: true });
    vi.mocked(resumeGuardDecision).mockReturnValue({ allow: true });
    const pm = fakePm({ getPid: vi.fn().mockReturnValue(42) });
    await resumeSession(pm, CHAT, TOPIC, PATH, SID);
    expect(resumeGuardDecision).toHaveBeenCalledWith({ pid: 42, alive: true }, 42);
  });
});
