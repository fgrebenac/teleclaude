import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkNodeVersion, checkClaudeCli, checkBotToken, checkOwners,
  checkGroups, checkProjectPaths, checkOptionalDeps, checkClaudeLogin,
  channelsPolicyNote, checkLiveViewVersion,
  compareVersions, parseClaudeVersion, isBelowVersion, formatResults,
  MIN_CLAUDE_VERSION, MIN_LIVE_VIEW_VERSION,
} from "./doctor.js";

const jsonRes = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe("doctor checks", () => {
  it("node version floor", () => {
    expect(checkNodeVersion("v20.11.0").ok).toBe(true);
    const old = checkNodeVersion("v18.19.0");
    expect(old.ok).toBe(false);
    expect(old.fix).toContain("20");
  });

  it("compareVersions orders semvers", () => {
    expect(compareVersions("2.1.121", "2.1.121")).toBe(0);
    expect(compareVersions("2.1.120", MIN_CLAUDE_VERSION)).toBeLessThan(0);
    expect(compareVersions("2.2.0", MIN_CLAUDE_VERSION)).toBeGreaterThan(0);
  });

  it("claude CLI: missing binary fails with a fix", async () => {
    const r = await checkClaudeCli(async () => { throw new Error("ENOENT"); });
    expect(r.ok).toBe(false);
    expect(r.fix).toBeTruthy();
  });

  it("claude CLI: version below floor fails, above passes", async () => {
    const at = async () => ({ stdout: "2.1.234 (Claude Code)" });
    const below = async () => ({ stdout: "2.0.9 (Claude Code)" });
    expect((await checkClaudeCli(at)).ok).toBe(true);
    expect((await checkClaudeCli(below)).ok).toBe(false);
  });

  it("claude login: reports credential presence", async () => {
    const good = await checkClaudeLogin(async () => "token-123");
    expect(good.ok).toBe(true);
    const bad = await checkClaudeLogin(async () => null);
    expect(bad.ok).toBe(false);
    expect(bad.fix).toContain("claude");
  });

  it("claude login: a never-resolving readToken times out instead of hanging", async () => {
    const neverResolves = () => new Promise<string | null>(() => {});
    const r = await checkClaudeLogin(neverResolves, 20);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("timeout");
    expect(r.fix).toBeTruthy();
  });

  it("bot token: getMe verdicts", async () => {
    const good = await checkBotToken("1:x", async () => jsonRes({ ok: true, result: { username: "mybot", id: 7 } }));
    expect(good.ok).toBe(true);
    expect(good.detail).toContain("@mybot");
    const bad = await checkBotToken("1:x", async () => jsonRes({ ok: false, description: "Unauthorized" }));
    expect(bad.ok).toBe(false);
    const missing = await checkBotToken(null, async () => jsonRes({}));
    expect(missing.ok).toBe(false);
    expect(missing.fix).toContain("setup");
  });

  it("bot token: network failure is reported, not thrown", async () => {
    const r = await checkBotToken("1:x", async () => { throw new Error("network down"); });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("api.telegram.org");
  });

  it("owners: empty set is a hard fail naming the consequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ownerTelegramId: 0, ownerTelegramIds: [], showUsageStats: true, defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90 } }));
    const r = checkOwners(dir);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ignored");
  });

  it("owners: non-empty set passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ownerTelegramId: 42, ownerTelegramIds: [42], showUsageStats: true, defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90 } }));
    const r = checkOwners(dir);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("42");
  });

  it("groups: no projects yet is a skip, not a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [] }));
    const [r] = await checkGroups("1:x", dir, async () => jsonRes({}));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("groups: no token is a skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ name: "p", path: "/tmp", chatId: 1, topicId: 2 }] }));
    const [r] = await checkGroups(null, dir, async () => jsonRes({}));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("groups: bot admin with Manage Topics passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ name: "p", path: "/tmp", chatId: -100, topicId: 2 }] }));
    const fetchImpl = async (url: string) => {
      if (url.includes("getMe")) return jsonRes({ ok: true, result: { id: 7 } });
      return jsonRes({ ok: true, result: { status: "administrator", can_manage_topics: true } });
    };
    const [r] = await checkGroups("1:x", dir, fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("Manage Topics");
  });

  it("groups: admin without Manage Topics fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ name: "p", path: "/tmp", chatId: -100, topicId: 2 }] }));
    const fetchImpl = async (url: string) => {
      if (url.includes("getMe")) return jsonRes({ ok: true, result: { id: 7 } });
      return jsonRes({ ok: true, result: { status: "administrator", can_manage_topics: false } });
    };
    const [r] = await checkGroups("1:x", dir, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.fix).toBeTruthy();
  });

  it("groups: non-admin member fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [{ name: "p", path: "/tmp", chatId: -100, topicId: 2 }] }));
    const fetchImpl = async (url: string) => {
      if (url.includes("getMe")) return jsonRes({ ok: true, result: { id: 7 } });
      return jsonRes({ ok: true, result: { status: "member" } });
    };
    const [r] = await checkGroups("1:x", dir, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not an admin");
  });

  it("project paths: missing dir fails, empty list skips", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: [] }));
    expect(checkProjectPaths(dir).skipped).toBe(true);

    const dir2 = mkdtempSync(join(tmpdir(), "tc-doc-"));
    writeFileSync(join(dir2, "projects.json"), JSON.stringify({ projects: [{ name: "gone", path: "/no/such/path/xyz", chatId: 1, topicId: 2 }] }));
    const r = checkProjectPaths(dir2);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("gone");
  });

  it("optional deps: found vs missing never fails the run", async () => {
    const found = await checkOptionalDeps(async () => ({ stdout: "/usr/bin/tool" }));
    expect(found.every((r) => r.ok)).toBe(true);
    const missing = await checkOptionalDeps(async () => { throw new Error("not found"); });
    expect(missing.every((r) => r.ok)).toBe(true);
    expect(missing.every((r) => r.skipped)).toBe(true);
  });

  it.each([
    ["2.1.246 (Claude Code)", "2.1.246"],
    ["2.1.300 (Claude Code)", "2.1.300"],
    ["2.1.9", "2.1.9"],
    ["not a version at all", null],
    ["", null],
  ])("parseClaudeVersion(%j) -> %j", (stdout, expected) => {
    expect(parseClaudeVersion(stdout)).toBe(expected);
  });

  it.each([
    ["2.1.245", MIN_LIVE_VIEW_VERSION, true],
    ["2.1.246", MIN_LIVE_VIEW_VERSION, false],
    ["2.1.247", MIN_LIVE_VIEW_VERSION, false],
    ["2.0.999", MIN_LIVE_VIEW_VERSION, true],
    ["3.0.0", MIN_LIVE_VIEW_VERSION, false],
  ])("isBelowVersion(%j, %j) -> %j", (version, floor, expected) => {
    expect(isBelowVersion(version, floor)).toBe(expected);
  });

  it("live view check: warns (never fails) below the floor, naming MessageDisplay", async () => {
    const r = await checkLiveViewVersion(async () => ({ stdout: "2.1.234 (Claude Code)" }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.detail).toContain("MessageDisplay");
    expect(r.detail).toContain(MIN_LIVE_VIEW_VERSION);
    expect(r.detail).toContain("tool/agent rows still work");
  });

  it("live view check: passes cleanly at/above the floor", async () => {
    const at = await checkLiveViewVersion(async () => ({ stdout: "2.1.246 (Claude Code)" }));
    expect(at.ok).toBe(true);
    expect(at.skipped).toBeFalsy();
    const above = await checkLiveViewVersion(async () => ({ stdout: "2.2.0 (Claude Code)" }));
    expect(above.ok).toBe(true);
    expect(above.skipped).toBeFalsy();
  });

  it("live view check: unparseable version is skipped without a warning", async () => {
    const r = await checkLiveViewVersion(async () => ({ stdout: "garbage output" }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.detail).not.toContain("MessageDisplay");
  });

  it("live view check: missing claude binary never throws", async () => {
    const r = await checkLiveViewVersion(async () => { throw new Error("ENOENT"); });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("channels policy note is always a documented skip", () => {
    const r = channelsPolicyNote();
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it("formatResults renders icons and fix lines", () => {
    const out = formatResults([
      { name: "A", ok: true, detail: "fine" },
      { name: "B", ok: false, detail: "broken", fix: "do X" },
      { name: "C", ok: true, skipped: true, detail: "n/a" },
    ]);
    expect(out).toContain("✅ A");
    expect(out).toContain("❌ B");
    expect(out).toContain("fix: do X");
    expect(out).toContain("⏭ C");
  });
});
