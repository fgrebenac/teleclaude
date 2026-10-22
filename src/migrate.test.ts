import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateToCompositeKeys, migrateBypassBoolean, countLegacyState } from "./migrate.js";

describe("migrateToCompositeKeys", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "teleclaude-mig-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  const readJson = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf-8"));

  it("re-keys sessions by chatId:topicId and backfills project.chatId", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "2": { sessionId: "s2", projectPath: "/p/a", chatId: -100, model: "opus" },
      "5": { sessionId: "s5", projectPath: "/p/b", chatId: -100 },
    }));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
      projects: [
        { name: "a", path: "/p/a", topicId: 2, createdAt: "x" },
        { name: "b", path: "/p/b", topicId: 5, createdAt: "x" },
      ],
    }));

    migrateToCompositeKeys(dir);

    const sessions = readJson("sessions.json");
    expect(sessions["-100:2"]?.sessionId).toBe("s2");
    expect(sessions["-100:5"]?.sessionId).toBe("s5");
    expect(sessions["2"]).toBeUndefined();

    const projects = readJson("projects.json").projects;
    expect(projects.find((p: any) => p.name === "a").chatId).toBe(-100);
    expect(projects.find((p: any) => p.name === "b").chatId).toBe(-100);
  });

  it("backfills a project with no session using the sole known chat", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "2": { sessionId: "s2", projectPath: "/p/a", chatId: -777 },
    }));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
      projects: [
        { name: "a", path: "/p/a", topicId: 2, createdAt: "x" },
        { name: "never-run", path: "/p/c", topicId: 9, createdAt: "x" },
      ],
    }));

    migrateToCompositeKeys(dir);

    const projects = readJson("projects.json").projects;
    expect(projects.find((p: any) => p.name === "never-run").chatId).toBe(-777);
  });

  it("is idempotent — already-composite keys are left untouched", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "-100:2": { sessionId: "s2", projectPath: "/p/a", chatId: -100 },
    }));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
      projects: [{ name: "a", path: "/p/a", chatId: -100, topicId: 2, createdAt: "x" }],
    }));

    migrateToCompositeKeys(dir);

    const sessions = readJson("sessions.json");
    expect(Object.keys(sessions)).toEqual(["-100:2"]);
    expect(readJson("projects.json").projects[0].chatId).toBe(-100);
  });
});

describe("migrateBypassBoolean", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "teleclaude-mig-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  const readSessions = () => JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8"));

  it("converts bypass:true to permissionMode 'bypass' and drops the field", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "-100:2": { sessionId: "s", projectPath: "/p", chatId: -100, bypass: true },
    }));
    expect(migrateBypassBoolean(dir)).toBe(1);
    const entry = readSessions()["-100:2"];
    expect(entry.permissionMode).toBe("bypass");
    expect("bypass" in entry).toBe(false);
  });

  it("converts bypass:false to 'default' — it was an explicit /bypass-off choice", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "-100:2": { sessionId: "s", projectPath: "/p", bypass: false },
    }));
    expect(migrateBypassBoolean(dir)).toBe(1);
    expect(readSessions()["-100:2"].permissionMode).toBe("default");
  });

  it("drops a bypass shadowed by an existing permissionMode without changing the mode", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "-100:2": { sessionId: "s", projectPath: "/p", bypass: true, permissionMode: "auto" },
    }));
    expect(migrateBypassBoolean(dir)).toBe(1);
    const entry = readSessions()["-100:2"];
    expect(entry.permissionMode).toBe("auto");
    expect("bypass" in entry).toBe(false);
  });

  it("is a no-op on a store with nothing to convert", () => {
    const clean = { "-100:2": { sessionId: "s", projectPath: "/p", permissionMode: "auto" } };
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(clean));
    expect(migrateBypassBoolean(dir)).toBe(0);
    expect(readSessions()).toEqual(clean);
  });

  it("returns 0 when sessions.json is missing", () => {
    expect(migrateBypassBoolean(dir)).toBe(0);
  });
});

describe("countLegacyState", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "teleclaude-mig-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("counts legacy session keys, bypass fields and chatId-less projects", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "446": { sessionId: "old", projectPath: "/p" },              // legacy key
      "-100:2": { sessionId: "s", projectPath: "/p", bypass: true }, // bypass field
      "-100:3": { sessionId: "s", projectPath: "/p", permissionMode: "auto" },
    }));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
      projects: [
        { name: "a", path: "/p/a", chatId: -100, topicId: 2, createdAt: "x" },
        { name: "garden", path: "/p/r", topicId: 446, createdAt: "x" },  // no chatId
      ],
    }));
    expect(countLegacyState(dir)).toEqual({ legacySessionKeys: 1, bypassFields: 1, chatlessProjects: 1 });
  });

  it("reports zeros for a fully migrated store", () => {
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({
      "-100:2": { sessionId: "s", projectPath: "/p", chatId: -100, permissionMode: "auto" },
    }));
    writeFileSync(join(dir, "projects.json"), JSON.stringify({
      projects: [{ name: "a", path: "/p/a", chatId: -100, topicId: 2, createdAt: "x" }],
    }));
    expect(countLegacyState(dir)).toEqual({ legacySessionKeys: 0, bypassFields: 0, chatlessProjects: 0 });
  });

  it("tolerates missing files", () => {
    expect(countLegacyState(dir)).toEqual({ legacySessionKeys: 0, bypassFields: 0, chatlessProjects: 0 });
  });
});
