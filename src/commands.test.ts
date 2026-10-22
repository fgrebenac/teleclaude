import { describe, it, expect } from "vitest";
import { parseNewCommand, parseDeleteCommand, parseRouteCommand, resolveRoute, normalizeRouteName } from "./commands.js";
import type { RouteProject } from "./commands.js";

describe("command parsing", () => {
  it("parses /new name path", () => {
    const result = parseNewCommand("/new myapp /Users/test/myapp");
    expect(result).toEqual({ name: "myapp", path: "/Users/test/myapp" });
  });

  it("parses /new with spaces in path", () => {
    const result = parseNewCommand("/new myapp /Users/test/my app");
    expect(result).toEqual({ name: "myapp", path: "/Users/test/my app" });
  });

  it("expands ~ in path", () => {
    const result = parseNewCommand("/new myapp ~/projects/test");
    expect(result).not.toBeNull();
    expect(result!.path).not.toContain("~");
    expect(result!.path).toContain("/projects/test");
  });

  it("returns null for invalid /new", () => {
    expect(parseNewCommand("/new")).toBeNull();
    expect(parseNewCommand("/new onlyname")).toBeNull();
  });

  it("parses /delete name", () => {
    expect(parseDeleteCommand("/delete myapp")).toEqual({ name: "myapp" });
    expect(parseDeleteCommand("/delete")).toBeNull();
  });
});

describe("parseRouteCommand", () => {
  it("parses /projectname content", () => {
    expect(parseRouteCommand("/recipes what did I eat today?")).toEqual({
      name: "recipes",
      content: "what did I eat today?",
    });
  });

  it("preserves multiline content", () => {
    expect(parseRouteCommand("/notes line one\nline two")).toEqual({
      name: "notes",
      content: "line one\nline two",
    });
  });

  it("tolerates @botname suffix", () => {
    expect(parseRouteCommand("/recipes@my_bot add an apple")).toEqual({
      name: "recipes",
      content: "add an apple",
    });
  });

  it("allows hyphens and underscores in names", () => {
    expect(parseRouteCommand("/shop-app hi")).toEqual({ name: "shop-app", content: "hi" });
    expect(parseRouteCommand("/my_proj hi")).toEqual({ name: "my_proj", content: "hi" });
  });

  it("returns null without content", () => {
    expect(parseRouteCommand("/recipes")).toBeNull();
    expect(parseRouteCommand("/recipes   ")).toBeNull();
  });

  it("returns null for non-command text", () => {
    expect(parseRouteCommand("hello there")).toBeNull();
    expect(parseRouteCommand("/123 numeric start")).toBeNull();
    expect(parseRouteCommand("")).toBeNull();
  });
});

describe("resolveRoute", () => {
  const projects: RouteProject[] = [
    { name: "Recipes", path: "/p/n", chatId: -100, topicId: 592 },
    { name: "Garden", path: "/p/r", topicId: 446 }, // legacy, no chatId
  ];

  it("resolves a known project case-insensitively", () => {
    const r = resolveRoute(projects, "recipes");
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.target.topicId).toBe(592);
  });

  it("reports no-chat for a project without a chatId", () => {
    const r = resolveRoute(projects, "Garden");
    expect(r.status).toBe("no-chat");
    expect(r.status === "no-chat" && r.target.name).toBe("Garden");
  });

  it("reports unknown for an unregistered name", () => {
    expect(resolveRoute(projects, "nope")).toEqual({ status: "unknown" });
  });

  // Telegram command names allow only [a-z0-9_], so the menu offers
  // /game_template and /cafe — routing has to accept those spellings.
  it("matches a hyphenated project via its underscore command name", () => {
    const hyphenated: RouteProject[] = [{ name: "Game-Template", path: "/p/u", chatId: -100, topicId: 7 }];
    expect(resolveRoute(hyphenated, "game_template").status).toBe("ok");
    expect(resolveRoute(hyphenated, "Game-Template").status).toBe("ok");
  });

  it("matches a project with diacritics via its ASCII command name", () => {
    const accented: RouteProject[] = [{ name: "Café", path: "/p/r", chatId: -100, topicId: 8 }];
    expect(resolveRoute(accented, "cafe").status).toBe("ok");
    expect(resolveRoute(accented, "Café").status).toBe("ok");
  });
});

describe("normalizeRouteName", () => {
  it("lowercases, strips diacritics and folds hyphens to underscores", () => {
    expect(normalizeRouteName("Game-Template")).toBe("game_template");
    expect(normalizeRouteName("Café")).toBe("cafe");
    expect(normalizeRouteName("data-toolbox")).toBe("data_toolbox");
    expect(normalizeRouteName("Recipes")).toBe("recipes");
  });

  it("is idempotent", () => {
    const once = normalizeRouteName("Garden-Web");
    expect(normalizeRouteName(once)).toBe(once);
  });
});
