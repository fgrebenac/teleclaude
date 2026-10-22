import { describe, it, expect } from "vitest";
import { resumeCwdDecision } from "./resume-cwd.js";

const ROOT = "/Users/x/teleclaude";
const WORKTREE = "/Users/x/teleclaude/.claude/worktrees/sdd-phase0-fixes";

describe("resumeCwdDecision", () => {
  it("needs no override when the session's home IS the root", () => {
    expect(resumeCwdDecision({ home: { cwd: ROOT }, rootReal: ROOT, cwdExists: true })).toEqual({
      ok: true,
      cwd: undefined,
    });
  });

  it("needs no override when the home couldn't be resolved at all", () => {
    expect(resumeCwdDecision({ home: null, rootReal: ROOT, cwdExists: false })).toEqual({
      ok: true,
      cwd: undefined,
    });
  });

  it("carries the worktree cwd when it still exists on disk", () => {
    expect(resumeCwdDecision({ home: { cwd: WORKTREE }, rootReal: ROOT, cwdExists: true })).toEqual({
      ok: true,
      cwd: WORKTREE,
    });
  });

  it("refuses with a reason when the worktree no longer exists on disk", () => {
    const decision = resumeCwdDecision({ home: { cwd: WORKTREE }, rootReal: ROOT, cwdExists: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain(WORKTREE);
      expect(decision.reason.toLowerCase()).toContain("no longer exists");
    }
  });
});
