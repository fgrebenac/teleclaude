import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, saveConfig, loadProjects, saveProjects, addProject, removeProject, clearConfigCache } from "./config.js";
import type { Config, ProjectsFile, Project } from "./config.js";

describe("config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "teleclaude-test-"));
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(testDir, { recursive: true });
  });

  it("returns default config when no file exists", () => {
    const config = loadConfig(testDir);
    expect(config.ownerTelegramId).toBe(0);
    expect(config.defaults.stallAlertMinutes).toBe(5);
  });

  it("saves and loads config", () => {
    const config: Config = {
      ownerTelegramId: 123456,
      showUsageStats: true,
      defaults: { stallAlertMinutes: 60, quotaAlertPercent: 90 },
    };
    saveConfig(config, testDir);
    const loaded = loadConfig(testDir);
    expect(loaded.ownerTelegramId).toBe(123456);
    expect(loaded.defaults.stallAlertMinutes).toBe(60);
  });

  it("returns empty projects when no file exists", () => {
    const projects = loadProjects(testDir);
    expect(projects.projects).toEqual([]);
  });

  it("adds and removes projects", () => {
    const project: Project = {
      name: "myapp",
      path: "/Users/test/myapp",
      chatId: -100123,
      topicId: 42,
      createdAt: new Date().toISOString(),
    };
    addProject(project, testDir);
    const loaded = loadProjects(testDir);
    expect(loaded.projects).toHaveLength(1);
    expect(loaded.projects[0].name).toBe("myapp");

    removeProject(-100123, "myapp", testDir);
    const after = loadProjects(testDir);
    expect(after.projects).toHaveLength(0);
  });

  it("resolves projects by (chat, topic) and scopes by chat", async () => {
    const { getProject, getProjectsForChat, getProjectByName } = await import("./config.js");
    const mk = (name: string, chatId: number, topicId: number): Project => ({
      name, path: `/p/${name}`, chatId, topicId, createdAt: new Date().toISOString(),
    });
    // Two different groups that happen to share topic id 2.
    addProject(mk("mine", -111, 2), testDir);
    addProject(mk("hers", -222, 2), testDir);

    expect(getProject(-111, 2, testDir)?.name).toBe("mine");
    expect(getProject(-222, 2, testDir)?.name).toBe("hers");
    expect(getProjectsForChat(-111, testDir).map((p) => p.name)).toEqual(["mine"]);
    expect(getProjectByName(-222, "hers", testDir)?.name).toBe("hers");
    expect(getProjectByName(-111, "hers", testDir)).toBeUndefined();
  });

  it("authorizedIds merges legacy field and list, de-duped", async () => {
    const { authorizedIds } = await import("./config.js");
    expect(authorizedIds({ ownerTelegramId: 1, ownerTelegramIds: [1, 2, 3], showUsageStats: true, defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90 } })).toEqual([1, 2, 3]);
    expect(authorizedIds({ ownerTelegramId: 5, showUsageStats: true, defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90 } })).toEqual([5]);
  });

  it("backfillProjectChat heals a chatId-less project and is idempotent", async () => {
    const { backfillProjectChat, getProject } = await import("./config.js");
    addProject({ name: "garden", path: "/p/garden", topicId: 446, createdAt: "x" } as Project, testDir);

    // First message in its topic stamps the chat.
    expect(backfillProjectChat(-100, 446, testDir)).toBe(true);
    expect(getProject(-100, 446, testDir)?.chatId).toBe(-100);

    // Already healed → no-op, doesn't re-stamp or move to another chat.
    expect(backfillProjectChat(-999, 446, testDir)).toBe(false);
    expect(getProject(-100, 446, testDir)?.chatId).toBe(-100);
  });

  it("backfillProjectChat is a no-op when nothing matches", async () => {
    const { backfillProjectChat } = await import("./config.js");
    addProject({ name: "set", path: "/p/s", chatId: -1, topicId: 7, createdAt: "x" }, testDir);
    expect(backfillProjectChat(-100, 999, testDir)).toBe(false); // unknown topic
    expect(backfillProjectChat(-100, 7, testDir)).toBe(false);   // already has chatId
  });
});

describe("ensureDir permissions", () => {
  it("creates the config dir 0700 — it holds the bot token", () => {
    const parent = mkdtempSync(join(tmpdir(), "tc-cfg-"));
    const dir = join(parent, "teleclaude");
    try {
      clearConfigCache();
      saveConfig(loadConfig(dir), dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      clearConfigCache();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("tightens an existing looser dir to 0700 on the next save", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-cfg-loose-"));
    try {
      chmodSync(dir, 0o755);
      clearConfigCache();
      saveConfig(loadConfig(dir), dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      clearConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
