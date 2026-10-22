import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { generalHelp, projectHelp, extrasHelp, scheduleHelp } from "./commands.js";

const TELEGRAM_LIMIT = 4096;

/** The two pages /help actually sends. */
const pages = {
  general: [...generalHelp(), "", ...projectHelp(), "", ...extrasHelp()].join("\n"),
  topic: [...projectHelp(), "", ...extrasHelp()].join("\n"),
  schedule: scheduleHelp().join("\n"),
};

/** Every command the bot registers, read from the handler sources. */
function registeredCommands(): string[] {
  const sources = ["./commands.ts", "./schedule.ts"].map((f) =>
    readFileSync(new URL(f, import.meta.url), "utf-8"),
  );
  const names = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/bot\.command\("([a-z]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

describe("/help", () => {
  it("fits in a single Telegram message", () => {
    for (const [name, text] of Object.entries(pages)) {
      expect(text.length, `${name} page`).toBeLessThan(TELEGRAM_LIMIT);
    }
  });

  /**
   * Registered but deliberately not advertised: /bypass exists only to point at
   * /permissions, because Telegram clients cache the command menu and a stale
   * entry would otherwise be forwarded to Claude as a prompt. Documenting it
   * would undo removing it.
   */
  const DEPRECATED = new Set(["bypass"]);

  it("documents every registered command", () => {
    const commands = registeredCommands().filter((c) => !DEPRECATED.has(c));
    expect(commands.length).toBeGreaterThan(15); // sanity: the regex found them
    const all = `${pages.general}\n${pages.schedule}`;
    for (const cmd of commands) {
      expect(all, `/${cmd} is undocumented`).toMatch(new RegExp(`/${cmd}\\b`));
    }
  });

  it("keeps deprecated commands out of the help pages", () => {
    const all = `${pages.general}\n${pages.topic}\n${pages.schedule}`;
    for (const cmd of DEPRECATED) {
      expect(all, `/${cmd} is deprecated and should not be advertised`).not.toMatch(new RegExp(`/${cmd}\\b`));
    }
  });

  it("keeps project-scope pages free of group-only commands", () => {
    expect(pages.topic).not.toMatch(/\/update\b/);
    expect(pages.topic).not.toMatch(/\/delete\b/);
    expect(pages.topic).not.toMatch(/\/ls\b/);
  });

  it("uses only Telegram-supported HTML and escapes placeholders", () => {
    for (const [name, text] of Object.entries(pages)) {
      // Any '<' must open one of Telegram's allowed tags — a raw "<name>"
      // placeholder would make sendMessage fail with a parse error.
      const tags = [...text.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
      for (const tag of tags) {
        expect(tag, `${name} page tag <${tag}>`).toMatch(/^\/?(b|i|code|pre|u|s)$/);
      }
    }
  });

  it("balances its HTML tags", () => {
    for (const [name, text] of Object.entries(pages)) {
      for (const tag of ["b", "i", "code"]) {
        const open = text.match(new RegExp(`<${tag}>`, "g"))?.length ?? 0;
        const close = text.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
        expect(open, `${name} page <${tag}>`).toBe(close);
      }
    }
  });
});
