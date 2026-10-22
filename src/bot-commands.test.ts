import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  GENERAL_COMMANDS, PROJECT_COMMANDS, GROUP_MERGED_DESCRIPTIONS, groupCommands, mergeCommands,
  projectCommands, commandsForChat, syncBotCommands,
} from "./bot-commands.js";
import { saveProjects, saveConfig, clearConfigCache, type Project } from "./config.js";

const VALID = /^[a-z][a-z0-9_]{0,31}$/;

function project(name: string, chatId?: number): Project {
  return { name, path: `/p/${name}`, chatId, topicId: 1, createdAt: "" };
}

describe("static command lists", () => {
  it("only contains names Telegram accepts", () => {
    for (const c of [...GENERAL_COMMANDS, ...PROJECT_COMMANDS]) {
      expect(c.command, c.command).toMatch(VALID);
    }
  });

  it("keeps descriptions within Telegram's 256 chars and non-empty", () => {
    for (const c of [...GENERAL_COMMANDS, ...PROJECT_COMMANDS]) {
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("has no duplicates within a list", () => {
    for (const list of [GENERAL_COMMANDS, PROJECT_COMMANDS]) {
      expect(new Set(list.map((c) => c.command)).size).toBe(list.length);
    }
  });

  it("merges scopes for a forum group without duplicating shared commands", () => {
    const merged = groupCommands();
    expect(new Set(merged.map((c) => c.command)).size).toBe(merged.length);
    expect(merged.map((c) => c.command)).toContain("delete");     // general-only
    expect(merged.map((c) => c.command)).toContain("screenshot"); // project-only
    expect(merged.map((c) => c.command)).toContain("rename");     // project-only
  });

  it("lists /live in the project topic scope only, not the General scope", () => {
    expect(PROJECT_COMMANDS.map((c) => c.command)).toContain("live");
    expect(GENERAL_COMMANDS.map((c) => c.command)).not.toContain("live");
    expect(groupCommands().map((c) => c.command)).toContain("live");
    // Project-topic-only: no collision to disambiguate, so no merged description.
    expect(GROUP_MERGED_DESCRIPTIONS.live).toBeUndefined();
  });

  it("describes both meanings for a name that means different things per topic", () => {
    // Telegram has no topic-scoped list, so the group menu is shared. Keeping
    // only General's description made "/new" read "Create a project" inside a
    // project topic, where it starts a fresh session.
    const merged = groupCommands();
    const newCmd = merged.find((c) => c.command === "new")!;
    expect(newCmd.description).toBe(GROUP_MERGED_DESCRIPTIONS.new);
    expect(newCmd.description).not.toBe(GENERAL_COMMANDS.find((c) => c.command === "new")!.description);
    expect(newCmd.description).toContain("Topic");
    expect(newCmd.description).toContain("General");
  });

  it("has a dual description for every command in both lists, and only those", () => {
    const inBoth = GENERAL_COMMANDS
      .map((c) => c.command)
      .filter((name) => PROJECT_COMMANDS.some((p) => p.command === name))
      // /help means the same thing in both, so it needs no disambiguation.
      .filter((name) => name !== "help");
    expect(inBoth.sort()).toEqual(Object.keys(GROUP_MERGED_DESCRIPTIONS).sort());
  });

  it("keeps the dual descriptions within Telegram's limit", () => {
    for (const [name, description] of Object.entries(GROUP_MERGED_DESCRIPTIONS)) {
      expect(description.length, name).toBeLessThanOrEqual(256);
      expect(description.length, name).toBeGreaterThan(0);
    }
  });

  it("leaves a command that exists in only one list untouched", () => {
    const merged = groupCommands();
    expect(merged.find((c) => c.command === "stop")?.description).toBe(
      PROJECT_COMMANDS.find((c) => c.command === "stop")!.description,
    );
    expect(merged.find((c) => c.command === "delete")?.description).toBe(
      GENERAL_COMMANDS.find((c) => c.command === "delete")!.description,
    );
  });

  it("mergeCommands keeps the first description", () => {
    expect(mergeCommands([{ command: "a", description: "first" }], [{ command: "a", description: "second" }]))
      .toEqual([{ command: "a", description: "first" }]);
  });
});

describe("projectCommands", () => {
  it("normalizes hyphens and diacritics into valid command names", () => {
    const cmds = projectCommands([project("Game-Template"), project("Café"), project("Recipes")], []);
    expect(cmds.map((c) => c.command)).toEqual(["game_template", "cafe", "recipes"]);
    for (const c of cmds) expect(c.command).toMatch(VALID);
  });

  it("names the project in the description", () => {
    expect(projectCommands([project("Garden-Web")], [])[0].description).toContain("Garden-Web");
  });

  it("skips names Telegram can't represent", () => {
    const cmds = projectCommands([project("42-apps"), project("a b"), project("what?!"), project("x".repeat(40))], []);
    expect(cmds).toEqual([]);
  });

  it("skips a project that would shadow a real command", () => {
    // /status is a registered handler — routing would never reach the project.
    expect(projectCommands([project("Status")], ["status"])).toEqual([]);
  });

  it("skips a second project normalizing to the same command", () => {
    const cmds = projectCommands([project("shop-app"), project("shop_app")], []);
    expect(cmds.map((c) => c.command)).toEqual(["shop_app"]);
  });
});

describe("commandsForChat", () => {
  it("appends project shortcuts after the base list", () => {
    const cmds = commandsForChat(GENERAL_COMMANDS, [project("Recipes")]);
    expect(cmds.slice(0, GENERAL_COMMANDS.length)).toEqual(GENERAL_COMMANDS);
    expect(cmds.at(-1)?.command).toBe("recipes");
  });

  it("truncates at Telegram's 100-command limit", () => {
    const many = Array.from({ length: 200 }, (_, i) => project(`proj${i}`));
    expect(commandsForChat(GENERAL_COMMANDS, many)).toHaveLength(100);
  });
});

describe("syncBotCommands", () => {
  let dir: string;
  const OWNER = 123456789;
  const GROUP_A = -1001;
  const GROUP_B = -1002;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-menu-"));
    saveConfig({ ownerTelegramId: OWNER, showUsageStats: true, defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90 } }, dir);
    saveProjects({ projects: [project("Recipes", GROUP_A), project("Atlas", GROUP_B), project("Garden")] }, dir);
  });

  afterEach(() => {
    clearConfigCache();
    rmSync(dir, { recursive: true });
  });

  function fakeBot() {
    const calls: Array<{ commands: Array<{ command: string }>; scope?: { type: string; chat_id?: number } }> = [];
    return {
      calls,
      api: {
        setMyCommands: vi.fn(async (commands: Array<{ command: string }>, other?: { scope?: any }) => {
          calls.push({ commands, scope: other?.scope });
        }),
      },
    };
  }

  it("sets the broad scopes plus one per owner DM and per group", async () => {
    const bot = fakeBot();
    await syncBotCommands(bot as any, dir);

    const scopes = bot.calls.map((c) => (c.scope ? `${c.scope.type}:${c.scope.chat_id ?? ""}` : "default"));
    expect(scopes).toEqual([
      "all_private_chats:",
      "all_group_chats:",
      "default",
      `chat:${OWNER}`,
      `chat:${GROUP_A}`,
      `chat:${GROUP_B}`,
    ]);
  });

  it("gives a group only its own projects", async () => {
    const bot = fakeBot();
    await syncBotCommands(bot as any, dir);

    const groupA = bot.calls.find((c) => c.scope?.chat_id === GROUP_A)!.commands.map((c) => c.command);
    expect(groupA).toContain("recipes");
    expect(groupA).not.toContain("atlas");
    expect(groupA).toContain("screenshot"); // project-topic commands are in the group menu
  });

  it("gives the owner's DM every project, since a DM can route anywhere", async () => {
    const bot = fakeBot();
    await syncBotCommands(bot as any, dir);

    const dm = bot.calls.find((c) => c.scope?.chat_id === OWNER)!.commands.map((c) => c.command);
    expect(dm).toContain("recipes");
    expect(dm).toContain("atlas");
    expect(dm).toContain("garden"); // no chatId yet, still routable by name
    expect(dm).not.toContain("screenshot"); // DMs use the general list
  });

  it("survives a Telegram error without throwing", async () => {
    const bot = fakeBot();
    bot.api.setMyCommands.mockRejectedValue(new Error("429 Too Many Requests"));
    await expect(syncBotCommands(bot as any, dir)).resolves.toBeUndefined();
  });
});
