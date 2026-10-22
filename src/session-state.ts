import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { topicKey } from "./bot.js";
import { writeJsonAtomic, readJsonTolerant } from "./fs-util.js";
import { resolvePermissionMode, type PermissionMode } from "./permission-mode.js";
import type { SpawnSettings } from "./processes.js";
import type { Project } from "./config.js";
import { LIVE_VIEW_MODES, type LiveViewMode } from "./turn-view.js";

function defaultDir(): string {
  return join(homedir(), ".teleclaude");
}

/** Where sessions.json lives — set once by loadSessionState (daemon boot passes
 *  its configDir; tests pass a mkdtemp dir). Same dir? pattern as config.ts and
 *  schedule-store.ts; session-state was the one store without it. */
let stateDir: string | undefined;

function statePath(): string {
  return join(stateDir ?? defaultDir(), "sessions.json");
}

export interface SessionEntry {
  sessionId: string;
  projectPath: string;
  chatId?: number;
  permissionMode?: PermissionMode;
  /** Legacy: superseded by permissionMode. Still read, so an explicit /bypass
   *  choice made before the auto-mode migration is honoured. */
  bypass?: boolean;
  model?: string;
  doneNotify?: boolean;
  /** When set, a turn that ends with uncommitted changes in the project prompts
   *  the user (📄 show diff / ✔️ leave it) — /review toggles it. Default off. */
  reviewOnDone?: boolean;
  effort?: string;
  /** Epoch ms of the last user message — gates which sessions auto-spawn on boot. */
  lastActiveAt?: number;
  /** Session display name (`claude -n`), set by /rename or `/new <name>`.
   *  Re-applied on every spawn so it survives a restart or /model switch. */
  name?: string;
  /** Opt-in: send a one-line ⏱/🔧/tokens receipt after each turn (/receipts). */
  receipts?: boolean;
  /** Keep a pinned message naming the current session (/pin). ABSENT = ON —
   *  unlike the other toggles, this one defaults enabled. */
  pinSession?: boolean;
  /** Telegram message id of the topic's pinned session-name message, so it can
   *  be edited in place across sessions (and daemon restarts). */
  pinnedMessageId?: number;
  /** What the pinned message currently says — skips a redundant Telegram edit
   *  per turn when nothing changed. */
  pinnedText?: string;
  /** Absolute cwd of the currently-resumed session's home, when it is NOT the
   *  project root (a worktree or arbitrary subfolder — see sessions.ts's
   *  sessionHomes). Re-applied on every spawn (spawnSettingsFor) so a
   *  worktree-homed session keeps resuming at the right place across a
   *  /model switch or boot auto-spawn. Cleared by /new and by resuming a
   *  session whose home IS the root. */
  sessionCwd?: string;
  /** Channel-server live-rendering mode (/live) — "full" keeps every detail
   *  live, "summary" collapses to the final text at turn end, "off" takes the
   *  same detailed-render path as "full" (no summary collapse) and only
   *  additionally gates narration off — tool outcomes and agent rows still
   *  render. Re-applied on every spawn via TELECLAUDE_LIVE_VIEW; unlike other
   *  settings, toggling it also pushes a live POST to the running channel
   *  server (no respawn). Absent = summary. */
  liveView?: LiveViewMode;
}

type SessionState = Record<string, SessionEntry>;

let state: SessionState = {};

export function loadSessionState(dir?: string): void {
  stateDir = dir;
  // Same test-isolation guard as saveSessionState, but for the read side: if
  // a test forgot loadSessionState(<temp dir>) and this resolves to the real
  // ~/.teleclaude, readJsonTolerant's corrupt-preserve rename would mutate
  // the operator's real sessions.json as a side effect of running the suite
  // — the exact hazard the save guard exists to close, just on load instead
  // of write. Skip the read entirely rather than merely skip the rename, so
  // a corrupt real file is left completely untouched under vitest.
  if (process.env.VITEST === "true" && (stateDir ?? defaultDir()) === defaultDir()) {
    state = {};
    return;
  }
  // Corrupt state is preserved as .corrupt-<ts> (readJsonTolerant), the same
  // treatment projects/config already get — the old bare catch reset every
  // topic's session/model/permission state to {} and the next save destroyed
  // the evidence.
  state = readJsonTolerant(statePath(), "sessions") ?? {};
}

export function saveSessionState(): void {
  const dir = stateDir ?? defaultDir();
  // Test-isolation guard: `npm version` runs the suite on the operator's live
  // machine on every release, possibly while the daemon is running. A test
  // that forgot loadSessionState(<temp dir>) must fail loudly here, not
  // silently corrupt (and race) the real store.
  if (process.env.VITEST === "true" && dir === defaultDir()) {
    throw new Error("session-state: refusing to write the real ~/.teleclaude under vitest — call loadSessionState(<temp dir>) first");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(statePath(), state);
}

export function getTopicSession(chatId: number, topicId: number): SessionEntry | undefined {
  return state[topicKey(chatId, topicId)];
}

export function setTopicSession(chatId: number, topicId: number, sessionId: string, projectPath: string): void {
  state[topicKey(chatId, topicId)] = { sessionId, projectPath, chatId };
  saveSessionState();
}

export function updateTopicSession(chatId: number, topicId: number, updates: Partial<SessionEntry>): void {
  const key = topicKey(chatId, topicId);
  const existing = state[key] ?? { sessionId: "", projectPath: "", chatId };
  state[key] = { ...existing, ...updates, chatId };
  saveSessionState();
}

/**
 * The spawn settings a topic's persisted state implies. Every spawn call site
 * goes through this so a newly persisted setting (this is how `name` arrived)
 * can't be silently dropped by the one path nobody updated — and so the
 * defaults live in one place instead of six.
 */
export function spawnSettingsFor(
  saved: SessionEntry | undefined,
  overrides: SpawnSettings = {},
): SpawnSettings {
  return {
    sessionId: saved?.sessionId || undefined,
    model: saved?.model ?? "sonnet",
    permissionMode: resolvePermissionMode(saved),
    doneNotify: saved?.doneNotify ?? false,
    effort: saved?.effort,
    name: saved?.name,
    cwd: saved?.sessionCwd,
    liveView: saved?.liveView && LIVE_VIEW_MODES.includes(saved.liveView) ? saved.liveView : "summary",
    ...overrides,
  };
}

export function clearTopicSession(chatId: number, topicId: number): void {
  delete state[topicKey(chatId, topicId)];
  saveSessionState();
}

/**
 * Whether a session counts as "recently active" for boot auto-spawn. A missing
 * timestamp (legacy entries) is treated as active so upgrades don't silently stop
 * spawning sessions that were previously resumed.
 */
export function isRecentlyActive(lastActiveAt: number | undefined, now: number, withinMs: number): boolean {
  return lastActiveAt === undefined || (now - lastActiveAt) < withinMs;
}

export type AutoSpawnDecision = { spawn: true } | { spawn: false; reason: string };

/**
 * Decide — at timer-fire time, not boot time — whether a queued boot auto-spawn
 * should still happen. The stagger delays these up to 5s*N after boot, and a
 * /new, /delete or /model in that window changes the answer; deciding on
 * values captured at boot could otherwise spawn a deleted project or resume a
 * /new'd topic with the session id it just cleared. The projectPathExists
 * check also keeps a missing directory from reaching pty.spawn, which throws
 * synchronously. NOTE: a bare `/stop` is deliberately NOT one of these —
 * it never clears sessionId/lastActiveAt (only /new does), so this decision
 * still approves a stopped topic and lets it resume, same as any other
 * message/schedule/boot would. That's the intended "resume via persisted
 * session id" contract, not something this check is meant to prevent.
 */
export function autoSpawnDecision(args: {
  project: Project | undefined;
  projectPathExists: boolean;
  saved: SessionEntry | undefined;
  now: number;
  recentMs: number;
}): AutoSpawnDecision {
  if (!args.project) return { spawn: false, reason: "project was deleted" };
  if (!args.projectPathExists) return { spawn: false, reason: `project dir missing: ${args.project.path}` };
  if (!args.saved?.sessionId) return { spawn: false, reason: "no persisted session (cleared since boot)" };
  if (!isRecentlyActive(args.saved.lastActiveAt, args.now, args.recentMs)) {
    return { spawn: false, reason: "no longer recently active" };
  }
  return { spawn: true };
}
