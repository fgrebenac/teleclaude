import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { log, logError } from "./log.js";
import { channelServerCommand, type McpCommand } from "./build-mode.js";
import { teleclaudeHookSettings } from "./hooks-config.js";
import { topicKey } from "./bot.js";
import { awaitsPromptConfirmation, classifyChannelLine, promptConfirmKeys } from "./channel-detect.js";
import { preTrustWorkspace } from "./claude-trust.js";
import { sessionTranscriptExists } from "./sessions.js";
import { loadConfig } from "./config.js";
import { DEFAULT_PERMISSION_MODE, permissionModeArgs, type PermissionMode } from "./permission-mode.js";
import { renameCommandText, RENAME_SUBMIT_DELAY_MS } from "./session-name.js";
import { sweepPort } from "./port-guard.js";
import type { LiveViewMode } from "./turn-view.js";
import * as pty from "node-pty";

const BASE_PORT = 8801;
const CALLBACK_PORT = 8800;
const MCP_CONFIG_DIR = "/tmp/teleclaude-mcp";
// How long after spawn raw PTY output is logged and scanned for channel
// banners. Both banners appear at startup; without a cap, a session whose
// registration line we never recognize would log its PTY (with conversation
// content) forever.
const PTY_STARTUP_WINDOW_MS = 90_000;

/** Every event ProcessManager can emit — the closed set message.ts and
 *  typing-state.ts dispatch on. A literal union so a typo'd emit or comparison
 *  fails tsc instead of silently never matching. */
export type ProcessEventName =
  | "reply"            // channel server confirmed a Telegram send/edit
  | "done"             // Stop hook — Claude finished a turn
  | "error"            // StopFailure — the turn failed terminally
  | "forwarded"        // /forward fallback send completed
  | "tool_use"         // PreToolUse — a tool started
  | "tool_stuck"       // watchdog: tool >2 min without new activity
  | "tool_escalate"    // watchdog: tool >5 min — offer force-stop
  | "compact"          // context compaction starting
  | "compacted"        // compaction finished
  | "subagent_start"
  | "subagent_stop"
  | "channel_blocked"  // org policy blocks channels (PTY banner)
  | "mcp_failed"       // PTY reported MCP server failure
  | "disconnected"     // process exited without an intentional kill
  | "killed";          // intentional kill (/stop, /new, /model, ...)

export type ProcessEvent = {
  chatId: number;
  topicId: number;
  event: ProcessEventName;
  messageId?: number;
  text?: string;
};
export type ProcessEventHandler = (event: ProcessEvent) => void;

export interface ToolActivity {
  toolName: string;
  input?: string; // truncated command for Bash
  startedAt: number;
}

interface ManagedProcess {
  pty: pty.IPty;
  port: number;
  projectPath: string;
  chatId: number;
  topicId: number;
  sessionId?: string;
  spawnToken: string;
  model: string;
  permissionMode: PermissionMode;
  doneNotify: boolean;
  effort?: string;
  exited: boolean;
  intentionalKill: boolean;
  spawnedAt: number;
  /** Tools started (PreToolUse) minus tools completed (PostToolUse). Claude runs
   *  tools in parallel — the watchdog may only stand down when this hits zero. */
  toolsInFlight: number;
  lastToolUse?: ToolActivity;
  toolWatchdog?: ReturnType<typeof setTimeout>;
  toolWatchdog2?: ReturnType<typeof setTimeout>;
  toolWatchdogFired: boolean;
  /** Channel registration state, parsed from PTY output. "pending" until Claude
   *  Code confirms the channel registered or reports an org-policy block. */
  channelStatus: "pending" | "registered" | "blocked";
  channelBlockedNotified: boolean;
  /** Claude Code rejected our `--resume` id ("No conversation found") — the
   *  process is already exiting, and the exit is not worth alarming about. */
  resumeRejected: boolean;
  /** Monotonic counter for the short-lived UI token embedded in "Cancel turn"
   *  button callback_data — purely for rejecting a stale button tap (an old
   *  alert for finished work shouldn't be tappable into interrupting new,
   *  unrelated work). Has NO involvement in cancellation safety — see
   *  cancelPending below. */
  turnSeq: number;
  turnNonce?: string;
  /** Claude Code's session display name (`claude -n`, or whatever a later
   *  /rename set). Mirrors what we asked for — the authoritative value lives in
   *  Claude Code's live-session registry, see claude-session-registry.ts. */
  name?: string;
  /** Sticky safety fence: true from the moment Ctrl+C is first written for
   *  this process's entire remaining lifetime. NEVER cleared by a done/error hook
   *  — only goes away when the whole process is torn down (kill) and a fresh
   *  one is spawned. See interruptTurn/hasCancelPending. */
  cancelPending: boolean;
}

export type ChannelStatus = "pending" | "registered" | "blocked";

/**
 * Everything a spawn needs beyond (chat, topic, cwd). An object rather than a
 * tail of positional arguments on purpose: `model`, `effort` and `name` are all
 * `string | undefined`, so a swapped pair would type-check cleanly and only
 * show up as a session launched with the wrong model — the same hazard that
 * already applies to spawn's (chatId, topicId) pair.
 */
export interface SpawnSettings {
  /** Resume this session instead of starting fresh. */
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
  doneNotify?: boolean;
  effort?: string;
  /** Display name for the session (`claude -n`). Re-applied on every spawn, so
   *  a name survives a restart, /model switch or boot auto-spawn. */
  name?: string;
  /** Spawn Claude Code in this directory instead of the project root — set
   *  when resuming a session that lives in a worktree/subfolder (see
   *  sessions.ts's sessionHomes/resolveSessionHome). Both the pty's cwd and
   *  TELECLAUDE_PROJECT_PATH (send_file's containment root) use this when
   *  present, which is intentional: a worktree is nested under the project
   *  root, so containment inside the project is unaffected, only which files
   *  a given spawn can reach. Resolved by resolveSpawnCwd, which first falls
   *  back to the project root when this directory no longer exists (a deleted
   *  worktree — transcripts live outside it and survive), then validates the
   *  transcript actually exists at the effective cwd. */
  cwd?: string;
  /** Channel-server live-rendering mode (/live), passed as TELECLAUDE_LIVE_VIEW
   *  at spawn so a respawn (boot, /model, resume, scheduler) keeps whatever
   *  was last set. A running process's mode can also change without a
   *  respawn — see the /live-mode POST in handlers/commands.ts. */
  liveView?: LiveViewMode;
}

/**
 * Resolve what cwd a spawn should actually use, and whether the requested
 * sessionId is still valid there. Pure and pty-free so it's unit-testable:
 * `spawn()` calls it once and applies the result to both the pty's cwd and
 * TELECLAUDE_PROJECT_PATH.
 *
 * Mirrors (and generalizes) the existing "expired sessions self-heal" check —
 * previously spawn() always tested the resume id's transcript against the
 * project root; now it tests against whichever cwd this call resolves to, so
 * a worktree-homed resume validates against its OWN directory instead of
 * always failing against the root's.
 */
export function resolveSpawnCwd(
  requestedCwd: string | undefined,
  projectPath: string,
  sessionId: string | undefined,
  transcriptExists: (sessionId: string, cwd: string) => boolean = sessionTranscriptExists,
  dirExists: (path: string) => boolean = existsSync,
): { cwd: string; sessionId: string | undefined } {
  // A requested cwd (a worktree/subfolder override) that no longer exists on
  // disk — e.g. `git worktree remove` ran after the session was resumed there
  // — must fall back to the project root BEFORE the transcript check below.
  // Transcripts live under ~/.claude/projects/<dashed-cwd>, entirely outside
  // the worktree itself, so they survive the worktree's removal: checking the
  // transcript first would see it "exists" at the now-deleted cwd and hand
  // that cwd straight to pty.spawn, which throws ENOENT synchronously (no
  // caller wraps this in try/catch). Falling back to the root FIRST lets the
  // existing stale-resume self-heal do its job on the normal path instead:
  // the transcript check then runs against the root, and drops the session id
  // exactly like any other expired resume if it has no transcript there either.
  const cwd = requestedCwd && !dirExists(requestedCwd) ? projectPath : requestedCwd ?? projectPath;
  if (sessionId && !transcriptExists(sessionId, cwd)) {
    return { cwd: projectPath, sessionId: undefined };
  }
  return { cwd, sessionId };
}

export type InterruptResult = "sent" | "not-running";

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private portCounter = BASE_PORT;
  private freedPorts: number[] = [];
  private botToken: string;
  private channelServer: McpCommand;
  /** Needed to read config at spawn time (strictMcpConfig). Optional for tests. */
  private configDir?: string;
  private onEvent: ProcessEventHandler | null = null;

  constructor(botToken: string, configDir?: string) {
    this.botToken = botToken;
    this.configDir = configDir;
    this.channelServer = channelServerCommand();
    mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  setEventHandler(handler: ProcessEventHandler): void {
    this.onEvent = handler;
  }

  handleCallback(chatId: number, topicId: number, event: ProcessEventName, extra?: { messageId?: number; text?: string }): void {
    this.onEvent?.({ chatId, topicId, event, ...extra });
  }

  isRunning(chatId: number, topicId: number): boolean {
    const mp = this.processes.get(topicKey(chatId, topicId));
    return mp !== undefined && !mp.exited;
  }

  getPort(chatId: number, topicId: number): number | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.port;
  }

  getSessionId(chatId: number, topicId: number): string | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.sessionId;
  }

  /** Channel registration state for a topic (undefined if no process). */
  getChannelStatus(chatId: number, topicId: number): ChannelStatus | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.channelStatus;
  }

  /** Authoritative "channel works" signal: called by the daemon when a
   *  token-valid hook arrives — Claude Code is demonstrably running turns for
   *  this spawn. Upgrade-only from "pending"; a detected block stays blocked. */
  markChannelRegistered(chatId: number, topicId: number): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (mp && mp.channelStatus === "pending") {
      mp.channelStatus = "registered";
      log(`[channel] topic=${topicId} registered (confirmed by hook)`);
    }
  }

  getSpawnToken(chatId: number, topicId: number): string | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.spawnToken;
  }

  /** Called by the callback server to register the session ID from the first hook event. */
  registerSessionId(chatId: number, topicId: number, sessionId: string): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (mp && !mp.sessionId) mp.sessionId = sessionId;
  }

  getModel(chatId: number, topicId: number): string {
    return this.processes.get(topicKey(chatId, topicId))?.model ?? "sonnet";
  }

  setModel(chatId: number, topicId: number, model: string): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (mp) mp.model = model;
  }

  getEffort(chatId: number, topicId: number): string | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.effort;
  }

  getPermissionMode(chatId: number, topicId: number): PermissionMode {
    return this.processes.get(topicKey(chatId, topicId))?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  }

  isDoneNotify(chatId: number, topicId: number): boolean {
    return this.processes.get(topicKey(chatId, topicId))?.doneNotify ?? false;
  }

  setDoneNotify(chatId: number, topicId: number, value: boolean): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (mp) mp.doneNotify = value;
  }

  getSpawnedAt(chatId: number, topicId: number): number | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.spawnedAt;
  }

  /** Record that a tool started running. Returns the activity object. */
  trackToolUse(chatId: number, topicId: number, toolName: string, input?: string): ToolActivity | undefined {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp) return;
    // Clear any existing watchdogs (incl. pending escalation from the previous tool)
    if (mp.toolWatchdog) clearTimeout(mp.toolWatchdog);
    if (mp.toolWatchdog2) clearTimeout(mp.toolWatchdog2);
    const activity: ToolActivity = { toolName, input, startedAt: Date.now() };
    mp.toolsInFlight++;
    mp.lastToolUse = activity;
    // ask_user legitimately blocks for minutes waiting on a human to answer a
    // Telegram prompt — its own 5-minute relay timeout already resolves it.
    // toolsInFlight/lastToolUse still update above (so the typing indicator and
    // the response-stall timer's "a tool is mid-flight, don't double-notify"
    // check keep working) — only the generic stuck-tool watchdog is skipped, to
    // avoid a false "may be stuck" warning on every normal unanswered question.
    // MCP tools report their fully-qualified name here (mcp__<server>__<tool>,
    // "teleclaude-channel" being our server key — see --allowedTools below),
    // not the bare name registered in channel-server.ts.
    if (toolName === "mcp__teleclaude-channel__ask_user") return activity;
    // Watchdog: warn if tool runs longer than 2 minutes without any new activity
    mp.toolWatchdog = setTimeout(() => {
      if (mp.lastToolUse === activity && !mp.exited) {
        const elapsed = Math.round((Date.now() - activity.startedAt) / 1000);
        log(`[watchdog] topic=${topicId} tool=${toolName} running for ${elapsed}s without new activity${input ? ` cmd=${input.slice(0, 120)}` : ""}`);
        if (!mp.toolWatchdogFired) {
          mp.toolWatchdogFired = true;
          this.onEvent?.({ chatId: mp.chatId, topicId, event: "tool_stuck", text: `${toolName} has been running for ${elapsed}s${input ? `: ${input.slice(0, 80)}` : ""}` });
        }
        // Escalate at 5 min — offer /stop button
        mp.toolWatchdog2 = setTimeout(() => {
          if (mp.lastToolUse === activity && !mp.exited) {
            const elapsed2 = Math.round((Date.now() - activity.startedAt) / 1000);
            log(`[watchdog] topic=${topicId} tool=${toolName} ESCALATING after ${elapsed2}s`);
            this.onEvent?.({ chatId: mp.chatId, topicId, event: "tool_escalate", text: `${toolName} has been running for ${elapsed2}s${input ? `: ${input.slice(0, 80)}` : ""}` });
          }
        }, 180_000); // 3 more minutes (5 min total)
      }
    }, 120_000);
    return activity;
  }

  /** Clear ALL tool tracking (turn boundary: done/reply/error). */
  clearToolUse(chatId: number, topicId: number): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp) return;
    if (mp.toolWatchdog) clearTimeout(mp.toolWatchdog);
    if (mp.toolWatchdog2) clearTimeout(mp.toolWatchdog2);
    mp.toolsInFlight = 0;
    mp.lastToolUse = undefined;
    mp.toolWatchdogFired = false; // reset so next stuck tool can warn again
  }

  /** One tool finished (PostToolUse). Only stand the watchdog down when NO tool
   *  is still in flight — with parallel tool calls, the first completion used to
   *  disarm the watchdog for a still-running (possibly stuck) sibling. */
  toolCompleted(chatId: number, topicId: number): void {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp) return;
    mp.toolsInFlight = Math.max(0, mp.toolsInFlight - 1);
    if (mp.toolsInFlight === 0) this.clearToolUse(chatId, topicId);
  }

  /** Get the last known tool activity for a topic. */
  getLastToolUse(chatId: number, topicId: number): ToolActivity | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.lastToolUse;
  }

  /** Mint a fresh UI token for "Cancel turn" buttons rendered from this point
   *  on. Call right before delivering a message to Claude Code (see
   *  sendToChannel in message.ts) so a button shown for an earlier delivery
   *  can be told apart from whatever the topic is doing now. This token is
   *  UI-only — it has no bearing on cancellation safety (see cancelPending). */
  beginTurn(chatId: number, topicId: number): { seq: number; nonce: string } | undefined {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp) return undefined;
    mp.turnSeq++;
    mp.turnNonce = randomBytes(4).toString("base64url");
    return { seq: mp.turnSeq, nonce: mp.turnNonce };
  }

  /** The current UI token for a topic, if any — used to validate a "Cancel
   *  turn" button tap against what's actually running now. */
  getCurrentTurnToken(chatId: number, topicId: number): { seq: number; nonce: string } | undefined {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp || mp.turnNonce === undefined) return undefined;
    return { seq: mp.turnSeq, nonce: mp.turnNonce };
  }

  /**
   * Request cancellation by writing Ctrl+C (`\x03`) into the PTY. Claude
   * Code's current keybinding reference separates two actions: Escape is
   * `chat:cancel` ("cancel current input"), Ctrl+C is `app:interrupt`
   * ("cancel current operation") — Escape alone was verified in production
   * to have zero effect on an actively-running turn in Channels mode, so
   * Ctrl+C is the mechanism actually being relied on here. Deliberately NOT
   * a process signal: this asks Claude Code to stop on its own terms and
   * keeps the process/session alive, where signalling the process risks
   * destabilizing or killing it outright (that's what Force Stop is for).
   *
   * This is topic-scoped, not turn-scoped: there is only ever one process per
   * topic, so "interrupt whatever this topic is doing right now" has no
   * "wrong target" to protect against (same as the pre-existing Force Stop
   * button). Every call writes the byte again, unconditionally — repeated
   * presses are harmless, the same way a human mashing Ctrl+C multiple times
   * is.
   *
   * Sets the sticky cancelPending fence BEFORE attempting the write (not
   * after), and never rolls it back even if the write throws: once a
   * cancellation has been requested, message.ts's StopFailure handling must
   * treat every subsequent failure on this process as expected, not as an
   * ordinary error worth auto-resending.
   */
  interruptTurn(chatId: number, topicId: number): InterruptResult {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp || mp.exited) return "not-running";
    mp.cancelPending = true;
    try {
      mp.pty.write("\x03");
      log(`[cancel] topic=${topicId} Ctrl+C sent`);
    } catch {
      // Process died between the check above and here — the fence stays set
      // regardless, since we can't be sure no byte landed.
    }
    return "sent";
  }

  /**
   * Rename a live session by typing Claude Code's own `/rename` into the PTY —
   * the same mechanism `/cancel` uses for Ctrl+C, and for the same reason:
   * there is no API for it, and the TUI is the only thing that can act on it.
   *
   * Pass `undefined` to send a bare `/rename`, which asks Claude Code to
   * generate a name from the conversation.
   *
   * Unlike the interrupt, the *result* of this is verifiable — Claude Code
   * writes the new name into `~/.claude/sessions/<pid>.json` — so callers should
   * read it back (see rename.ts) rather than trusting a "sent". The local `name`
   * is updated optimistically so a respawn re-applies the requested name even
   * if the read-back never confirms.
   */
  sendRenameCommand(chatId: number, topicId: number, name?: string): InterruptResult {
    const mp = this.processes.get(topicKey(chatId, topicId));
    if (!mp || mp.exited) return "not-running";
    try {
      // Text first, Enter separately — a single write is taken as a paste on
      // newer Claude Code and never submits (see RENAME_SUBMIT_DELAY_MS).
      mp.pty.write(renameCommandText(name));
      setTimeout(() => {
        if (mp.exited) return;
        try { mp.pty.write("\r"); } catch { /* died meanwhile — read-back reports it */ }
      }, RENAME_SUBMIT_DELAY_MS);
      if (name) mp.name = name;
      log(`[rename] topic=${topicId} typed /rename ${name ?? "(auto)"}`);
    } catch {
      // Died between the check and the write — nothing renamed, and the caller's
      // read-back will report it as unconfirmed.
      return "not-running";
    }
    return "sent";
  }

  /** The name we last asked this session to use, if any. Claude Code's registry
   *  is authoritative — see claude-session-registry.ts. */
  getSessionName(chatId: number, topicId: number): string | undefined {
    return this.processes.get(topicKey(chatId, topicId))?.name;
  }

  /** PTY child pid — the key into Claude Code's live-session registry. */
  getPid(chatId: number, topicId: number): number | undefined {
    const mp = this.processes.get(topicKey(chatId, topicId));
    return mp && !mp.exited ? mp.pty.pid : undefined;
  }

  /** Whether a cancellation has ever been requested for this process's
   *  current lifetime. Sticky — can only be cleared by the process itself
   *  being torn down and replaced (see kill()/spawn()). Read this BEFORE
   *  calling kill() in a StopFailure handler — kill() deletes the process
   *  state this reads from. */
  hasCancelPending(chatId: number, topicId: number): boolean {
    return this.processes.get(topicKey(chatId, topicId))?.cancelPending ?? false;
  }

  nextPort(): number {
    return this.freedPorts.pop() ?? this.portCounter++;
  }

  /**
   * Spawn a Claude Code process in a PTY for a topic.
   * PTY required so Claude Code stays in interactive mode (channels need it).
   * Pass sessionId to resume a specific session.
   */
  spawn(chatId: number, topicId: number, projectPath: string, settings: SpawnSettings = {}): number {
    const {
      model = "sonnet",
      permissionMode = DEFAULT_PERMISSION_MODE,
      doneNotify = false,
      effort,
      name,
      liveView = "summary",
    } = settings;
    const key = topicKey(chatId, topicId);
    if (this.isRunning(chatId, topicId)) {
      log(`[process] spawn topic=${topicId} already running on :${this.processes.get(key)!.port}`);
      return this.processes.get(key)!.port;
    }

    this.processes.delete(key);

    // Resuming a transcript that Claude Code's retention sweep already deleted is
    // fatal (exit code=1 in ~2s). Every spawn path can carry a stale id — boot
    // auto-spawn, /model, /permissions, sendToChannel — so validate here, at the one
    // choke point, and fall back to a fresh session rather than dying. Also
    // resolves settings.cwd (a worktree/subfolder override) against the SAME
    // check, so a worktree-homed resume validates against its own directory.
    const { cwd: effectiveCwd, sessionId } = resolveSpawnCwd(settings.cwd, projectPath, settings.sessionId || undefined);
    if (settings.sessionId && !sessionId) {
      log(`[process] topic=${topicId} resume ${settings.sessionId.slice(0, 8)} has no transcript at ${settings.cwd ?? projectPath} — spawning fresh`);
    }
    // Pre-trust here, not only in /new and /ls: a project can reach spawn without
    // either (projects.json restored on a new machine, a worktree cwd), and the
    // trust dialog's default is "No, exit" — an unattended Enter declines it.
    preTrustWorkspace(effectiveCwd);

    // Ensure the port is free before starting. Kills only orphaned teleclaude
    // channel servers — a foreign listener (a customer's own dev server on
    // 88xx) is never killed; we skip to a fresh port instead, and never
    // re-offer the occupied one.
    let port = this.nextPort();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (sweepPort(port) !== "foreign") break;
      log(`[process] port ${port} is held by a non-teleclaude process — trying the next one`);
      port = this.portCounter++;
    }
    // Random token embedded in every hook URL — terminal Claude Code sessions in the same
    // directory fire the same hooks but don't know the token, so they get silently rejected.
    const spawnToken = randomBytes(16).toString("hex");
    log(`[process] spawn chat=${chatId} topic=${topicId} port=${port} cwd=${effectiveCwd} model=${model} effort=${effort ?? "auto"} perms=${permissionMode} name=${name ?? "(claude-derived)"} session=${sessionId?.slice(0, 8) ?? "new"}`);

    const callbackBase = `http://127.0.0.1:${CALLBACK_PORT}?chat=${chatId}&topic=${topicId}&token=${spawnToken}`;

    // Write MCP config to temp file. Dev checkout: "npx tsx" on the .ts source
    // ("node --import tsx" breaks MCP stdio — never that). Bundled build: plain
    // "node" on dist/channel-server.js (spike-verified). See build-mode.ts.
    // Named per (chat, topic) — topic ids collide across chats.
    // Re-create the dir on every spawn: macOS purges /private/tmp entries older than
    // a few days, so a long-lived daemon can't rely on the constructor's mkdir.
    mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const mcpConfigPath = join(MCP_CONFIG_DIR, `topic-${chatId}-${topicId}.json`);
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        "teleclaude-channel": {
          command: this.channelServer.command,
          args: [...this.channelServer.args],
          env: {
            TELECLAUDE_PORT: String(port),
            TELEGRAM_BOT_TOKEN: this.botToken,
            TELECLAUDE_TOPIC_ID: String(topicId),
            TELECLAUDE_CHAT_ID: String(chatId),
            TELECLAUDE_CALLBACK_URL: callbackBase,
            TELECLAUDE_AUTH_TOKEN: spawnToken,
            // send_file's containment root (path-containment.ts) — the tool is
            // pre-approved via --allowedTools, so this env var is the only
            // boundary between it and the whole filesystem. Uses the resolved
            // spawn cwd (a worktree override, when present) rather than always
            // the project root — the worktree is nested under the root, so
            // this only narrows what a given spawn can reach, never widens it.
            TELECLAUDE_PROJECT_PATH: effectiveCwd,
            // Channel-server live-rendering mode (Task 5/6): read once at startup
            // (invalid/absent → "summary" there too); the running server can also
            // be switched at runtime via POST /live-mode without a respawn.
            TELECLAUDE_LIVE_VIEW: liveView,
          },
        },
      },
    }, null, 2), { mode: 0o600 });

    // Hooks go in a per-spawn settings file passed with --settings, NOT into the
    // project's own .claude/settings.local.json. Written there, they applied to
    // every Claude Code session in that directory — the user's terminal sessions
    // fired teleclaude's callbacks on every tool use, which the daemon then had
    // to recognise and reject — and any hook key a later version stopped
    // installing stayed behind firing forever. --settings merges with the
    // file-based sources, so the user's own hooks still run alongside ours.
    // 0600 in a 0700 dir: the URLs embed the spawn token, which doubles as the
    // channel server's HTTP auth.
    const settingsPath = join(MCP_CONFIG_DIR, `settings-${chatId}-${topicId}.json`);
    writeFileSync(settingsPath, JSON.stringify(teleclaudeHookSettings(callbackBase), null, 2), { mode: 0o600 });
    try { chmodSync(settingsPath, 0o600); } catch { /* ignore */ }

    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
    );

    // Screenshot tools can return an image block (see image-content.ts), and
    // Claude Code counts image payloads against MAX_MCP_OUTPUT_TOKENS (the
    // `anthropic/maxResultSizeChars` annotation covers text only), so the 25k
    // default risks truncating one into a file reference. What the limit
    // actually measures for an image — base64 chars, decoded bytes, or vision
    // tokens — is undocumented, so this is a deliberate margin at the scale the
    // docs themselves use as an example (50k), not a computed value. It applies
    // to every MCP server in the session, hence a bump rather than a big raise,
    // and never when the user has set their own value.
    if (!env.MAX_MCP_OUTPUT_TOKENS) env.MAX_MCP_OUTPUT_TOKENS = "45000";

    const args = [
      "--dangerously-load-development-channels", "server:teleclaude-channel",
      "--mcp-config", mcpConfigPath,
      "--settings", settingsPath,
      "--model", model,
      // Always auto-approve our own channel tools + safe read-only tools.
      // These are narrow, per-tool rules, so auto mode carries them over — it
      // only drops broad code-execution grants like Bash(*) or Agent rules.
      "--allowedTools", "mcp__teleclaude-channel__reply", "mcp__teleclaude-channel__send_file", "mcp__teleclaude-channel__screenshot", "mcp__teleclaude-channel__browse", "mcp__teleclaude-channel__ask_user", "mcp__teleclaude-channel__send_page",
    ];
    if (effort) args.push("--effort", effort);
    // Claude Code names every session itself (e.g. "todo-c6"); -n overrides
    // that with the topic's persisted name so /status, the terminal /resume
    // picker and the prompt box all agree.
    if (name) args.push("--name", name);
    args.push(...permissionModeArgs(permissionMode));
    // --mcp-config is additive: without this the topic also loads every globally
    // configured MCP server, so its tool surface depends on unrelated installs
    // and it inherits auth/elicitation prompts nobody can answer from a phone.
    if (loadConfig(this.configDir).defaults?.strictMcpConfig !== false) {
      args.push("--strict-mcp-config");
    }
    if (sessionId) args.push("--resume", sessionId);
    log(`[process] claude args: ${args.join(" ")}`);

    const child = pty.spawn("claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: effectiveCwd,
      env,
    });

    const mp: ManagedProcess = { pty: child, port, projectPath, chatId, topicId, sessionId, spawnToken, model, permissionMode, doneNotify, effort, name, exited: false, intentionalKill: false, spawnedAt: Date.now(), toolsInFlight: 0, toolWatchdogFired: false, channelStatus: "pending", channelBlockedNotified: false, resumeRejected: false, turnSeq: 0, cancelPending: false };

    // Auto-confirm startup dialogs with nobody at the keyboard. Claude Code may
    // show a workspace trust prompt (new directory) and then the development-
    // channels warning. Two mechanisms, on purpose:
    //
    //  1. Detection (below, in onData): answer each dialog when it actually
    //     appears, however many there are. This is the reliable path.
    //  2. The original blind Enters on a timer, kept as a fallback in case a
    //     future version stops printing the affordance we match on. Harmless:
    //     an Enter at an idle REPL is a no-op, which is already the common case
    //     today for a trusted project that only shows one dialog.
    let promptConfirms = 0;
    let lastPromptConfirmAt = 0;
    // The TUI redraws the same dialog repeatedly, so bound both the rate and the
    // total — without that, one dialog could absorb an unbounded stream of Enters.
    const PROMPT_CONFIRM_COOLDOWN_MS = 700;
    const PROMPT_CONFIRM_MAX = 4;
    setTimeout(() => {
      if (!mp.exited && promptConfirms === 0) child.write("\r");
    }, 2000);
    setTimeout(() => {
      if (!mp.exited && promptConfirms < 2) child.write("\r");
    }, 4000);

    // Rolling scan buffer for channel-state detection — PTY chunks split at
    // arbitrary boundaries, so a banner can straddle two onData events.
    let scanBuf = "";
    let promptBuf = "";
    const debugPty = process.env.TELECLAUDE_DEBUG_PTY === "1";
    child.onData((data) => {
      const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "").trim();
      if (!clean) return;
      // Startup window: current Claude Code never prints the registration
      // confirmation, so "pending" alone can last the whole process lifetime —
      // the time cap guarantees PTY logging/scanning always stops.
      const startupWindow = mp.channelStatus === "pending" && Date.now() - mp.spawnedAt < PTY_STARTUP_WINDOW_MS;
      // Raw PTY output is only logged during startup (TUI redraws would otherwise
      // dominate the log — and leak conversation content into it). Set
      // TELECLAUDE_DEBUG_PTY=1 to log everything.
      if (startupWindow || debugPty) {
        log(`[claude:${topicId}] ${clean}`);
      }
      // Detect MCP server failure from PTY output
      if (clean.includes("MCP server failed") || clean.includes("MCP server disconnected")) {
        log(`[mcp] topic=${topicId} detected MCP failure from PTY: ${clean.slice(0, 120)}`);
        this.onEvent?.({ chatId, topicId, event: "mcp_failed", text: clean.slice(0, 200) });
      }
      // Detect channel registration state. An org-policy block means inbound
      // messages are silently dropped — surface it once so the user isn't left
      // in the dark waiting for a reply that can never come. Only classified
      // during the startup window: both banners appear at startup, and matching
      // forever would false-trigger on assistant output that merely *mentions*
      // the banner text (e.g. a session working on this repo).
      // Answer a startup dialog as soon as it renders, instead of betting on a
      // fixed delay. Own buffer, not scanBuf: this one gets cleared on every
      // confirmation so the *next* dialog needs fresh output to match, and
      // clearing the shared buffer could drop a half-received block banner.
      if (startupWindow && promptConfirms < PROMPT_CONFIRM_MAX) {
        promptBuf = (promptBuf + "\n" + clean).slice(-2048);
        const now = Date.now();
        if (awaitsPromptConfirmation(promptBuf) && now - lastPromptConfirmAt > PROMPT_CONFIRM_COOLDOWN_MS) {
          promptConfirms++;
          lastPromptConfirmAt = now;
          const keys = promptConfirmKeys(promptBuf);
          promptBuf = "";
          log(`[process] topic=${topicId} startup dialog detected — confirming (#${promptConfirms}${keys.length > 1 ? ", moving to Yes first" : ""})`);
          if (!mp.exited) child.write(keys[0]);
          if (keys.length > 1) {
            // Separate writes: sent as one chunk the TUI can read Down+Enter as a
            // single unknown sequence. Clear promptBuf again — the redraw after
            // Down still says "Enter to confirm" and must not trigger a second Enter.
            setTimeout(() => {
              promptBuf = "";
              if (!mp.exited) child.write(keys[1]);
            }, 150);
          }
        }
      }
      if (startupWindow) {
        scanBuf = (scanBuf + "\n" + clean).slice(-4096);
        const channelClass = classifyChannelLine(scanBuf);
        if (channelClass === "blocked") {
          mp.channelStatus = "blocked";
          log(`[channel] topic=${topicId} BLOCKED by org policy — inbound messages dropped`);
          if (!mp.channelBlockedNotified) {
            mp.channelBlockedNotified = true;
            this.onEvent?.({ chatId, topicId, event: "channel_blocked", text: clean.slice(0, 200) });
          }
        } else if (channelClass === "session-missing") {
          // Claude Code refused the --resume id and is exiting. The pre-spawn
          // check above catches the usual cause (deleted transcript); this covers
          // ids Claude Code rejects for any other reason.
          mp.resumeRejected = true;
          scanBuf = "";
          logError(`[process] topic=${topicId} Claude Code rejected resume ${mp.sessionId?.slice(0, 8) ?? "?"} — no such conversation`);
        } else if (channelClass === "registered") {
          mp.channelStatus = "registered";
          scanBuf = "";
          log(`[channel] topic=${topicId} registered — channel active`);
        }
      }
    });

    child.onExit(({ exitCode }) => {
      mp.exited = true;
      log(`[claude:${topicId}] exited code=${exitCode}${mp.resumeRejected ? " (--resume rejected)" : ""}`);
      // Only notify if not intentionally killed (by /stop, /new, /permissions, /model, etc.)
      if (!mp.intentionalKill) {
        this.onEvent?.({ chatId, topicId, event: "disconnected" });
      }
    });

    this.processes.set(key, mp);
    log(`[process] spawned claude topic=${topicId} port=${port} cwd=${projectPath}${sessionId ? ` resume=${sessionId.slice(0, 8)}` : ""}`);

    return port;
  }

  /** Kill a Claude Code process. */
  kill(chatId: number, topicId: number): void {
    const key = topicKey(chatId, topicId);
    const mp = this.processes.get(key);
    if (!mp) return;
    mp.intentionalKill = true;
    if (mp.toolWatchdog) clearTimeout(mp.toolWatchdog);
    if (mp.toolWatchdog2) clearTimeout(mp.toolWatchdog2);
    this.freedPorts.push(mp.port);
    // SIGINT, not the default SIGHUP: Claude Code (2.1.132+) treats an
    // externally delivered SIGINT as a graceful shutdown — it flushes
    // session/transcript state and prints a resume hint before exiting,
    // instead of just dying. Since every /stop, /new, /model etc. already
    // relies on the next message resuming via the persisted session id,
    // giving Claude Code a chance to shut down cleanly first makes that
    // resume more reliable, not just faster.
    try { mp.pty.kill("SIGINT"); } catch { /* already dead */ }
    // Sweep the channel server port (orphaned MCP subprocess). Identity-checked:
    // a foreign process that raced onto a recycled port is left alone.
    sweepPort(mp.port);
    // Clean up MCP config file (contains bot token)
    try { unlinkSync(join(MCP_CONFIG_DIR, `topic-${chatId}-${topicId}.json`)); } catch { /* ignore */ }
    try { unlinkSync(join(MCP_CONFIG_DIR, `settings-${chatId}-${topicId}.json`)); } catch { /* ignore */ }
    mp.exited = true;
    this.processes.delete(key);
    log(`[process] killed chat=${chatId} topic=${topicId}`);
    // Stop typing indicator — typing may have been active when kill() was called
    this.onEvent?.({ chatId, topicId, event: "killed" });
  }

  /** Kill and respawn with fresh session — for /new command. */
  restart(chatId: number, topicId: number, projectPath: string, settings: SpawnSettings = {}): number {
    this.kill(chatId, topicId);
    return this.spawn(chatId, topicId, projectPath, { ...settings, sessionId: undefined });
  }

  /** Status of all managed processes. */
  status(): { chatId: number; topicId: number; port: number; projectPath: string; running: boolean; sessionId?: string }[] {
    return [...this.processes.values()].map((mp) => ({
      chatId: mp.chatId,
      topicId: mp.topicId,
      port: mp.port,
      projectPath: mp.projectPath,
      running: !mp.exited,
      sessionId: mp.sessionId,
    }));
  }

  /** Kill all — for shutdown. */
  killAll(): void {
    for (const mp of [...this.processes.values()]) {
      this.kill(mp.chatId, mp.topicId);
    }
  }
}
