import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { collectGitDiff, formatDiffHeader, dirtySignature, reviewPromptText, diffCwdFor } from "./git-diff.js";
import { loadSessionState, updateTopicSession } from "./session-state.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
}

describe("collectGitDiff", () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "teleclaude-gitdiff-"));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reports isRepo=false for a plain directory", async () => {
    const dir = join(base, "plain");
    mkdirSync(dir);
    const r = await collectGitDiff(dir);
    expect(r.isRepo).toBe(false);
    expect(r.hasChanges).toBe(false);
  });

  it("reports a clean repo as no changes", async () => {
    const dir = join(base, "clean");
    mkdirSync(dir);
    git(dir, "init");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "init");
    const r = await collectGitDiff(dir);
    expect(r.isRepo).toBe(true);
    expect(r.hasChanges).toBe(false);
    expect(r.stat).toBe("");
    expect(r.patch).toBe("");
    expect(r.untracked).toEqual([]);
  });

  it("captures modified (staged + unstaged) and untracked files", async () => {
    const dir = join(base, "dirty");
    mkdirSync(dir);
    git(dir, "init");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "init");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n"); // unstaged edit
    writeFileSync(join(dir, "new.txt"), "hello\n");  // untracked
    const r = await collectGitDiff(dir);
    expect(r.hasChanges).toBe(true);
    expect(r.stat).toContain("a.txt");
    expect(r.patch).toContain("+two");
    expect(r.untracked).toEqual(["new.txt"]);
    expect(r.truncated).toBe(false);
  });

  it("handles a repo with no commits yet (no HEAD)", async () => {
    const dir = join(base, "nohead");
    mkdirSync(dir);
    git(dir, "init");
    writeFileSync(join(dir, "only.txt"), "x\n");
    const r = await collectGitDiff(dir);
    expect(r.isRepo).toBe(true);
    expect(r.hasChanges).toBe(true);        // untracked file counts as reviewable
    expect(r.untracked).toEqual(["only.txt"]);
  });
});

describe("formatDiffHeader", () => {
  it("escapes git output and lists untracked files", () => {
    const html = formatDiffHeader({ stat: "a<b>.txt | 2 +-", untracked: ["x&y.txt"], truncated: false });
    expect(html).toContain("a&lt;b&gt;.txt");
    expect(html).toContain("x&amp;y.txt");
    expect(html).not.toContain("<b>.txt");
  });

  it("clips an oversized stat and notes truncation", () => {
    const html = formatDiffHeader({ stat: "x".repeat(10_000), untracked: [], truncated: true });
    expect(html.length).toBeLessThan(4_000);
    expect(html).toContain("[clipped]");
    expect(html).toContain("Patch too large");
  });

  it("caps the untracked listing at 15", () => {
    const untracked = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    const html = formatDiffHeader({ stat: "", untracked, truncated: false });
    expect(html).toContain("…and 5 more");
  });
});

describe("dirtySignature", () => {
  it("is order-insensitive and empty for a clean tree", () => {
    expect(dirtySignature(" M a.txt\n?? b.txt\n")).toBe(dirtySignature("?? b.txt\n M a.txt\n"));
    expect(dirtySignature("")).toBe("");
    expect(dirtySignature(" M a.txt\n")).not.toBe(dirtySignature(" M c.txt\n"));
  });
});

describe("reviewPromptText", () => {
  it("pluralizes", () => {
    expect(reviewPromptText(1)).toContain("1 uncommitted file ");
    expect(reviewPromptText(3)).toContain("3 uncommitted files");
  });
});

describe("diffCwdFor", () => {
  const CHAT = 42;
  const TOPIC = 7;
  let sessionDir: string;
  let existingCwd: string;

  beforeAll(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "teleclaude-git-diff-session-"));
    loadSessionState(sessionDir);
    existingCwd = mkdtempSync(join(tmpdir(), "teleclaude-git-diff-cwd-"));
  });
  afterAll(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(existingCwd, { recursive: true, force: true });
  });

  it("falls back to the project root when there is no session entry", () => {
    expect(diffCwdFor(CHAT, TOPIC + 100, "/root")).toBe("/root");
  });

  it("falls back to the project root when sessionCwd is unset", () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1" });
    expect(diffCwdFor(CHAT, TOPIC, "/root")).toBe("/root");
  });

  it("uses sessionCwd when it exists on disk", () => {
    updateTopicSession(CHAT, TOPIC, { sessionCwd: existingCwd });
    expect(diffCwdFor(CHAT, TOPIC, "/root")).toBe(existingCwd);
  });

  it("falls back to the project root when sessionCwd points at a deleted directory", () => {
    updateTopicSession(CHAT, TOPIC, { sessionCwd: join(existingCwd, "gone-worktree") });
    expect(diffCwdFor(CHAT, TOPIC, "/root")).toBe("/root");
  });
});
