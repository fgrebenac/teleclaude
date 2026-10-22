import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pruneTeleclaudeHooks, sweepProjectHooks, teleclaudeHookSettings, TELECLAUDE_HOOK_EVENTS } from "./hooks-config.js";

const BASE = "http://127.0.0.1:8800?topic=42&token=abc";

describe("TELECLAUDE_HOOK_EVENTS", () => {
  it("includes the live-turn-view narration and failed-tool events", () => {
    expect(TELECLAUDE_HOOK_EVENTS).toContainEqual(["MessageDisplay", "narration"]);
    expect(TELECLAUDE_HOOK_EVENTS).toContainEqual(["PostToolUseFailure", "tool_failed"]);
  });

  it("has exactly 14 hook events", () => {
    // A hardcoded count so a future addition/removal is a deliberate edit
    // here, not a silent drift discovered elsewhere.
    expect(TELECLAUDE_HOOK_EVENTS.length).toBe(14);
  });
});

describe("teleclaudeHookSettings", () => {
  it("installs an http hook for every event teleclaude listens to", () => {
    const { hooks } = teleclaudeHookSettings(BASE);
    expect(Object.keys(hooks).sort()).toEqual(TELECLAUDE_HOOK_EVENTS.map(([e]) => e).sort());
    for (const [event, name] of TELECLAUDE_HOOK_EVENTS) {
      const entry = hooks[event][0];
      expect(entry.hooks?.[0].type).toBe("http");
      expect(entry.hooks?.[0].url).toBe(`${BASE}&event=${name}`);
    }
  });

  it("carries the spawn token into every hook URL", () => {
    // The daemon rejects any callback whose token doesn't match the live spawn.
    const { hooks } = teleclaudeHookSettings(BASE);
    for (const entries of Object.values(hooks)) {
      expect(String(entries[0].hooks?.[0].url)).toContain("token=abc");
    }
  });

  it("contains nothing but hooks — it must not override other settings keys", () => {
    // --settings overrides the keys it names, so naming anything else here would
    // silently replace the user's value for this session.
    expect(Object.keys(teleclaudeHookSettings(BASE))).toEqual(["hooks"]);
  });

  it("is self-contained: no dependence on what's already on disk", () => {
    // The old merge path read the project's settings file; this one can't, which
    // is what keeps the user's directory untouched.
    expect(teleclaudeHookSettings(BASE)).toEqual(teleclaudeHookSettings(BASE));
  });
});

const ORIGIN = "http://127.0.0.1:8800";
const tcHook = (event: string, token = "abc") => ({
  matcher: "",
  hooks: [{ type: "http", url: `${ORIGIN}?chat=-100&topic=42&token=${token}&event=${event}` }],
});
/** The real fossil found on disk: retired event, no chat id, no token. */
const FOSSIL = { matcher: "", hooks: [{ type: "http", url: `${ORIGIN}?topic=42&event=working` }] };
const USER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };

describe("pruneTeleclaudeHooks", () => {
  it("removes teleclaude entries from managed AND retired keys", () => {
    // At boot every teleclaude hook is dead, including ones for events we still
    // install — the spawn token they carry died with the previous daemon.
    const { hooks, removed } = pruneTeleclaudeHooks(
      { Stop: [tcHook("done")], UserPromptSubmit: [FOSSIL] },
      ORIGIN,
    );
    expect(removed).toBe(2);
    expect(hooks).toEqual({});
  });

  it("preserves the user's own hooks", () => {
    const { hooks, removed } = pruneTeleclaudeHooks(
      { PreToolUse: [USER_HOOK, tcHook("tool_use")] },
      ORIGIN,
    );
    expect(removed).toBe(1);
    expect(hooks.PreToolUse).toEqual([USER_HOOK]);
  });

  it("drops a key only when nothing is left in it", () => {
    const { hooks } = pruneTeleclaudeHooks({ Stop: [tcHook("done")], PreToolUse: [USER_HOOK] }, ORIGIN);
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.PreToolUse).toEqual([USER_HOOK]);
  });

  it("leaves hooks pointing at some other host alone", () => {
    const foreign = { matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:9999?event=done" }] };
    const { hooks, removed } = pruneTeleclaudeHooks({ Stop: [foreign] }, ORIGIN);
    expect(removed).toBe(0);
    expect(hooks.Stop).toEqual([foreign]);
  });

  it("is a no-op on empty or missing input", () => {
    expect(pruneTeleclaudeHooks(undefined, ORIGIN)).toEqual({ hooks: {}, removed: 0 });
    expect(pruneTeleclaudeHooks({}, ORIGIN)).toEqual({ hooks: {}, removed: 0 });
  });
});

describe("sweepProjectHooks", () => {
  const dirs: string[] = [];
  function project(settings: unknown | null): string {
    const dir = mkdtempSync(join(tmpdir(), "teleclaude-sweep-"));
    dirs.push(dir);
    if (settings !== null) {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      const body = typeof settings === "string" ? settings : JSON.stringify(settings, null, 2);
      writeFileSync(join(dir, ".claude", "settings.local.json"), body);
    }
    return dir;
  }
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf-8"));

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prunes fossils and keeps unrelated settings intact", () => {
    const dir = project({
      permissions: { allow: ["Bash(ls)"] },
      hooks: { UserPromptSubmit: [FOSSIL], PreToolUse: [USER_HOOK, tcHook("tool_use")] },
    });
    const result = sweepProjectHooks([dir], ORIGIN);
    expect(result).toEqual({ scanned: 1, changed: 1, removed: 2 });

    const after = read(dir);
    expect(after.hooks.UserPromptSubmit).toBeUndefined();
    expect(after.hooks.PreToolUse).toEqual([USER_HOOK]);
    expect(after.permissions, "unrelated settings survive").toEqual({ allow: ["Bash(ls)"] });
  });

  it("removes the hooks key entirely when only teleclaude hooks were there", () => {
    const dir = project({ other: 1, hooks: { Stop: [tcHook("done")] } });
    sweepProjectHooks([dir], ORIGIN);
    const after = read(dir);
    expect("hooks" in after).toBe(false);
    expect(after.other).toBe(1);
  });

  it("doesn't rewrite a file that has nothing to prune", () => {
    // Boot runs this over every project; churning mtimes each time is rude.
    const dir = project({ hooks: { PreToolUse: [USER_HOOK] } });
    const before = statSync(join(dir, ".claude", "settings.local.json")).mtimeMs;
    const result = sweepProjectHooks([dir], ORIGIN);
    expect(result.changed).toBe(0);
    expect(statSync(join(dir, ".claude", "settings.local.json")).mtimeMs).toBe(before);
  });

  it("skips an unparseable settings file instead of truncating it", () => {
    // The file is the user's; losing their hooks to fix ours is a bad trade.
    const dir = project("{ not json");
    const result = sweepProjectHooks([dir], ORIGIN);
    expect(result).toEqual({ scanned: 0, changed: 0, removed: 0 });
    expect(readFileSync(join(dir, ".claude", "settings.local.json"), "utf-8")).toBe("{ not json");
  });

  it("ignores projects with no settings file", () => {
    expect(sweepProjectHooks([project(null)], ORIGIN)).toEqual({ scanned: 0, changed: 0, removed: 0 });
  });

  it("keeps the settings file owner-only (hook URLs carry the spawn token)", () => {
    const dir = project({ hooks: { UserPromptSubmit: [FOSSIL], PreToolUse: [USER_HOOK] } });
    sweepProjectHooks([dir], ORIGIN);
    const mode = statSync(join(dir, ".claude", "settings.local.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("processes every project even when one is broken", () => {
    const bad = project("nope");
    const good = project({ hooks: { UserPromptSubmit: [FOSSIL] } });
    const result = sweepProjectHooks([bad, good], ORIGIN);
    expect(result.removed).toBe(1);
    expect(result.changed).toBe(1);
  });
});
