import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { contextWindowFor, sessionTranscriptExists, sessionNameFromEntry, lineMayCarrySessionName, sessionTitleFromEntry, promptLabel } from "./sessions.js";
import { REPLY_REMINDER } from "./channel-instructions.js";

// sessions.ts resolves transcripts under homedir() — point it at a temp tree so
// the test neither reads nor writes the developer's real ~/.claude.
// (built without `join` — vi.hoisted runs before the imports are initialized;
// realpathSync is required inline for the same reason — the module's own `fs`
// import isn't initialized yet either.)
//
// The base is realpath'd once so FAKE_HOME already equals its own realpath:
// on macOS, TMPDIR lives under /var/folders, itself a symlink to
// /private/var/folders. projectDirName() (sessions.ts) realpath-resolves a
// project root before dash-joining it into a `~/.claude/projects/<name>`
// directory name — matching how Claude Code itself names project storage —
// so a raw, un-resolved FAKE_HOME would make any path built from it dash-join
// to a DIFFERENT name than what projectDirName computes, breaking the
// worktree-prefix candidate scan purely as a test artifact of this symlink.
const FAKE_HOME = vi.hoisted(() => {
  const rfs = require("fs");
  const base = process.env.TMPDIR?.replace(/\/$/, "") ?? "/tmp";
  let realBase = base;
  try { realBase = rfs.realpathSync(base); } catch { /* use as-is */ }
  return `${realBase}/teleclaude-sessions-test-${process.pid}`;
});
vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => FAKE_HOME,
}));

describe("sessionTranscriptExists", () => {
  // Matches Claude Code's own naming: every non-alphanumeric char becomes "-".
  const PROJECT = "/tmp/teleclaude-fake-project";
  const PROJECT_DIR = join(FAKE_HOME, ".claude", "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
  const LIVE = "1683c6eb-684a-4b96-8fcd-1e0e716fb3d8";

  beforeAll(() => {
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(join(PROJECT_DIR, `${LIVE}.jsonl`), '{"type":"user"}\n');
  });
  afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

  it("finds a transcript that is still on disk", () => {
    expect(sessionTranscriptExists(LIVE, PROJECT)).toBe(true);
  });

  it("reports a swept transcript as gone", () => {
    // The real failure: the id survives in sessions.json, the .jsonl does not.
    expect(sessionTranscriptExists("dead1234-0000-0000-0000-000000000000", PROJECT)).toBe(false);
  });

  it("reports gone when the project has no session directory at all", () => {
    expect(sessionTranscriptExists(LIVE, "/tmp/teleclaude-never-used")).toBe(false);
  });

  it("does not mistake a directory for a transcript", () => {
    mkdirSync(join(PROJECT_DIR, "memory.jsonl"), { recursive: true });
    expect(sessionTranscriptExists("memory", PROJECT)).toBe(false);
  });
});

describe("contextWindowFor", () => {
  it("returns 1M for [1m] models", () => {
    expect(contextWindowFor("claude-opus-4-8[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6[1m]")).toBe(1_000_000);
  });

  it("returns 200K for standard models", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("returns 200K for empty/unknown model strings", () => {
    expect(contextWindowFor("")).toBe(200_000);
  });
});

describe("sessionNameFromEntry", () => {
  // All three shapes below were produced by a single /rename on Claude Code
  // 2.1.234 — the structured pair is current, the stdout line is what older
  // transcripts carry.
  it("reads the structured custom-title record", () => {
    expect(sessionNameFromEntry({ type: "custom-title", customTitle: "api work", sessionId: "x" })).toBe("api work");
  });

  it("reads the structured agent-name record", () => {
    expect(sessionNameFromEntry({ type: "agent-name", agentName: "api work", sessionId: "x" })).toBe("api work");
  });

  it("still reads the legacy stdout line", () => {
    expect(sessionNameFromEntry({
      type: "system",
      subtype: "local_command",
      content: "<local-command-stdout>Session renamed to: api work</local-command-stdout>",
    })).toBe("api work");
  });

  it("ignores everything else", () => {
    expect(sessionNameFromEntry({ type: "user", message: { role: "user", content: "hi" } })).toBeNull();
    expect(sessionNameFromEntry({ type: "custom-title", customTitle: "   " })).toBeNull();
    expect(sessionNameFromEntry({ type: "agent-name" })).toBeNull();
    expect(sessionNameFromEntry({ type: "system", subtype: "local_command", content: "<command-name>/rename</command-name>" })).toBeNull();
    expect(sessionNameFromEntry(null)).toBeNull();
    expect(sessionNameFromEntry("not an object")).toBeNull();
  });

  it("trims the name", () => {
    expect(sessionNameFromEntry({ type: "custom-title", customTitle: "  api work  " })).toBe("api work");
  });
});

describe("lineMayCarrySessionName", () => {
  it("accepts every line shape a name can arrive in", () => {
    expect(lineMayCarrySessionName('{"type":"custom-title","customTitle":"x"}')).toBe(true);
    expect(lineMayCarrySessionName('{"type":"agent-name","agentName":"x"}')).toBe(true);
    expect(lineMayCarrySessionName('{"content":"<local-command-stdout>Session renamed to: x</local-command-stdout>"}')).toBe(true);
  });

  it("accepts Claude Code's ai-title record", () => {
    expect(lineMayCarrySessionName('{"type":"ai-title","aiTitle":"x"}')).toBe(true);
  });

  it("rejects ordinary transcript lines — it exists to skip the JSON.parse", () => {
    expect(lineMayCarrySessionName('{"type":"assistant","message":{"content":"hello"}}')).toBe(false);
  });
});

describe("sessionTitleFromEntry", () => {
  it("reads Claude Code's ai-title record, trimmed", () => {
    expect(sessionTitleFromEntry({ type: "ai-title", aiTitle: "  Open-sourcing this project ", sessionId: "x" })).toBe("Open-sourcing this project");
  });

  it("ignores everything else", () => {
    expect(sessionTitleFromEntry({ type: "ai-title", aiTitle: "  " })).toBeNull();
    expect(sessionTitleFromEntry({ type: "custom-title", customTitle: "api work" })).toBeNull();
    expect(sessionTitleFromEntry(null)).toBeNull();
  });
});

describe("promptLabel", () => {
  const channel = (body: string) => `<channel source="teleclaude-channel" sender="user" topic_id="52" delivery_id="d1">\n${body}\n</channel>`;

  it("strips the channel envelope and the first-message reply-tool reminder", () => {
    expect(promptLabel(channel(REPLY_REMINDER + "do we support naming sessions?"))).toBe("do we support naming sessions?");
  });

  it("leaves a plain terminal prompt alone, collapsing whitespace", () => {
    expect(promptLabel("fix the\n\nlogin   bug")).toBe("fix the login bug");
  });

  it("returns null for slash-command echoes and caveats, so the caller keeps looking", () => {
    expect(promptLabel("<local-command-caveat>Caveat: The messages below were generated by the user</local-command-caveat>")).toBeNull();
    expect(promptLabel("<command-name>/model</command-name>")).toBeNull();
    expect(promptLabel(channel(REPLY_REMINDER))).toBeNull();
  });

  it("shortens a teleclaude file upload to the file name", () => {
    expect(promptLabel(channel(REPLY_REMINDER + "[File uploaded to /tmp/up/receipt.pdf] file this"))).toBe("📎 receipt.pdf file this");
  });

  it("truncates to the max length", () => {
    expect(promptLabel("x".repeat(200))).toHaveLength(80);
  });
});

import { sessionTranscriptPath } from "./sessions.js";
import { join as joinPath } from "path";

describe("sessionTranscriptPath", () => {
  it("mirrors Claude Code's directory-naming rule", () => {
    const p = sessionTranscriptPath("abc", "/x/v2.1.0");
    expect(p.endsWith(joinPath(".claude", "projects", "-x-v2-1-0", "abc.jsonl"))).toBe(true);
  });
});

import { sessionHomes, resolveSessionHome, clearSessionHomesCache, listProjectSessions } from "./sessions.js";

describe("sessionHomes / resolveSessionHome / listProjectSessions (worktree-aware)", () => {
  const ROOT = join(FAKE_HOME, "work", "teleclaude");
  const ROOT_DIR = join(FAKE_HOME, ".claude", "projects", ROOT.replace(/[^a-zA-Z0-9]/g, "-"));
  const WORKTREE = join(ROOT, ".claude", "worktrees", "sdd-phase0-fixes");
  const WORKTREE_DIR = join(FAKE_HOME, ".claude", "projects", WORKTREE.replace(/[^a-zA-Z0-9]/g, "-"));
  // The false-positive case from the brainstorm: a SIBLING project whose name
  // starts with the root's name plus a dash, which the cheap prefix filter
  // alone cannot distinguish from a real worktree.
  const SIBLING = join(FAKE_HOME, "work", "teleclaude-docs");
  const SIBLING_DIR = join(FAKE_HOME, ".claude", "projects", SIBLING.replace(/[^a-zA-Z0-9]/g, "-"));

  const ROOT_SESSION = "11111111-0000-0000-0000-000000000000";
  const WORKTREE_SESSION = "22222222-0000-0000-0000-000000000000";

  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true });
    mkdirSync(WORKTREE, { recursive: true });
    mkdirSync(ROOT_DIR, { recursive: true });
    mkdirSync(WORKTREE_DIR, { recursive: true });
    mkdirSync(SIBLING_DIR, { recursive: true });

    writeFileSync(
      join(ROOT_DIR, `${ROOT_SESSION}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: ROOT, message: { content: "hi from root" } })}\n`,
    );
    writeFileSync(
      join(WORKTREE_DIR, `${WORKTREE_SESSION}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: WORKTREE, message: { content: "hi from worktree" } })}\n`,
    );
    // A transcript whose cwd is genuinely outside the root — must be excluded
    // even though its directory name prefix-matches.
    writeFileSync(
      join(SIBLING_DIR, "33333333-0000-0000-0000-000000000000.jsonl"),
      `${JSON.stringify({ type: "user", cwd: SIBLING, message: { content: "hi from sibling" } })}\n`,
    );
  });
  afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));
  afterEach(() => clearSessionHomesCache());

  it("always includes the root home first, even with zero transcripts", () => {
    const homes = sessionHomes(join(FAKE_HOME, "work", "brand-new"));
    expect(homes).toHaveLength(1);
    expect(homes[0].subpath).toBe("");
  });

  it("finds the worktree home and labels it with the relative subpath", () => {
    const homes = sessionHomes(ROOT);
    const worktreeHome = homes.find((h) => h.dir === WORKTREE_DIR);
    expect(worktreeHome).toBeDefined();
    expect(worktreeHome!.subpath).toBe(join(".claude", "worktrees", "sdd-phase0-fixes"));
    expect(worktreeHome!.cwd).toBe(WORKTREE);
  });

  it("excludes the sibling project despite the dash-joined name prefix-matching", () => {
    const homes = sessionHomes(ROOT);
    expect(homes.some((h) => h.dir === SIBLING_DIR)).toBe(false);
  });

  it("caches the homes list for a project root within the TTL", () => {
    const now = 1_000_000;
    const first = sessionHomes(ROOT, now);
    // A call within 60s reuses the cached array (same reference) even if the
    // caller passes different clock values inside the window.
    const second = sessionHomes(ROOT, now + 1_000);
    expect(second).toBe(first);
    const third = sessionHomes(ROOT, now + 61_000);
    expect(third).not.toBe(first);
  });

  it("resolveSessionHome finds the home actually holding a session's transcript", () => {
    expect(resolveSessionHome(ROOT, WORKTREE_SESSION)).toEqual({ cwd: WORKTREE });
    expect(resolveSessionHome(ROOT, ROOT_SESSION)).toEqual({ cwd: ROOT });
  });

  it("resolveSessionHome returns null for an id that exists nowhere", () => {
    expect(resolveSessionHome(ROOT, "no-such-session")).toBeNull();
  });

  it("skips a candidate transcript whose first line is literal `null` without throwing, and still finds a cwd on a later line", () => {
    const NULL_FIRST = join(ROOT, ".claude", "worktrees", "null-first-line");
    const NULL_FIRST_DIR = join(FAKE_HOME, ".claude", "projects", NULL_FIRST.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(NULL_FIRST_DIR, { recursive: true });
    writeFileSync(
      join(NULL_FIRST_DIR, "44444444-0000-0000-0000-000000000000.jsonl"),
      `null\n${JSON.stringify({ type: "user", cwd: NULL_FIRST, message: { content: "hi" } })}\n`,
    );
    clearSessionHomesCache();
    expect(() => sessionHomes(ROOT)).not.toThrow();
    const homes = sessionHomes(ROOT);
    const home = homes.find((h) => h.dir === NULL_FIRST_DIR);
    expect(home).toBeDefined();
    expect(home!.cwd).toBe(NULL_FIRST);
  });

  it("skips a candidate transcript made up of only `null` lines, without throwing", () => {
    const ALL_NULL = join(ROOT, ".claude", "worktrees", "all-null-lines");
    const ALL_NULL_DIR = join(FAKE_HOME, ".claude", "projects", ALL_NULL.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(ALL_NULL_DIR, { recursive: true });
    writeFileSync(join(ALL_NULL_DIR, "55555555-0000-0000-0000-000000000000.jsonl"), "null\nnull\n");
    clearSessionHomesCache();
    expect(() => sessionHomes(ROOT)).not.toThrow();
    const homes = sessionHomes(ROOT);
    expect(homes.some((h) => h.dir === ALL_NULL_DIR)).toBe(false);
  });

  it("listProjectSessions aggregates root + worktree sessions, tagging subpath only on the worktree one", async () => {
    const sessions = await listProjectSessions(ROOT);
    const root = sessions.find((s) => s.sessionId === ROOT_SESSION);
    const worktree = sessions.find((s) => s.sessionId === WORKTREE_SESSION);
    expect(root).toBeDefined();
    expect(root!.subpath).toBeUndefined();
    expect(worktree).toBeDefined();
    expect(worktree!.subpath).toBe(join(".claude", "worktrees", "sdd-phase0-fixes"));
    // The sibling's session must never appear.
    expect(sessions.some((s) => s.sessionId === "33333333-0000-0000-0000-000000000000")).toBe(false);
  });

  it("labels a session by user name, then Claude Code's ai-title, then the first real prompt", async () => {
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    const telegramPrompt = { type: "user", cwd: ROOT, message: { content: `<channel source="teleclaude-channel">\n${REPLY_REMINDER}add a dark mode toggle\n</channel>` } };
    const caveat = { type: "user", cwd: ROOT, message: { content: "<local-command-caveat>Caveat: generated by a local command</local-command-caveat>" } };
    writeFileSync(join(ROOT_DIR, "aaaaaaaa-0000-0000-0000-000000000001.jsonl"), line(caveat) + line(telegramPrompt));
    writeFileSync(join(ROOT_DIR, "aaaaaaaa-0000-0000-0000-000000000002.jsonl"),
      line(telegramPrompt) + line({ type: "ai-title", aiTitle: "Old title" }) + line({ type: "ai-title", aiTitle: "Dark mode toggle" }));
    writeFileSync(join(ROOT_DIR, "aaaaaaaa-0000-0000-0000-000000000003.jsonl"),
      line(telegramPrompt) + line({ type: "custom-title", customTitle: "theme work" }) + line({ type: "ai-title", aiTitle: "Dark mode toggle" }));

    const sessions = await listProjectSessions(ROOT);
    const label = (id: string) => sessions.find((s) => s.sessionId === `aaaaaaaa-0000-0000-0000-00000000000${id}`)?.summary;
    expect(label("1")).toBe("add a dark mode toggle");
    expect(label("2")).toBe("Dark mode toggle");
    expect(label("3")).toBe("theme work");
  });
});
