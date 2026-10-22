import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { loadConfig, loadProjects, authorizedIds } from "./config.js";
import { readAccessToken } from "./claude-auth.js";

const execFileP = promisify(execFile);

// Every exec/network check gets a bound so `doctor` can never hang the
// terminal (or a caller scripting it) waiting on a wedged subprocess or a
// stalled TCP connection.
const EXEC_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 5_000;
// claude-auth.ts's readAccessToken shells out to `security find-generic-password`
// on macOS with no timeout of its own (shared by /model, /usage and this check) —
// bounding it here, rather than in claude-auth.ts, keeps those other callers'
// behavior untouched while still making doctor hang-proof.
export const LOGIN_CHECK_TIMEOUT_MS = 5_000;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** What the user should do when ok=false. */
  fix?: string;
  /** The check couldn't run / is informational — not a failure. */
  skipped?: boolean;
}

export const MIN_NODE_MAJOR = 20;
/** Oldest Claude Code that honors anthropic/alwaysLoad — reply-tool pinning needs it (CLAUDE.md). */
export const MIN_CLAUDE_VERSION = "2.1.121";
/** Oldest Claude Code that fires the MessageDisplay hook (live turn view narration, CLAUDE.md "Live turn view"). */
export const MIN_LIVE_VIEW_VERSION = "2.1.246";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Pulls the first x.y.z out of `claude --version` output (e.g. "2.1.246 (Claude Code)"); null if unparseable. */
export function parseClaudeVersion(stdout: string): string | null {
  return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function isBelowVersion(version: string, floor: string): boolean {
  return compareVersions(version, floor) < 0;
}

export function checkNodeVersion(version: string = process.version): CheckResult {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    name: "Node.js",
    ok,
    detail: `${version} (need >= ${MIN_NODE_MAJOR})`,
    fix: ok ? undefined : "Install Node.js 20 or newer: https://nodejs.org",
  };
}

type RunLike = (cmd: string, args: string[]) => Promise<{ stdout: string | Buffer }>;
const defaultRun: RunLike = (cmd, args) => execFileP(cmd, args, { timeout: EXEC_TIMEOUT_MS });

export async function checkClaudeCli(run: RunLike = defaultRun): Promise<CheckResult> {
  try {
    const { stdout } = await run("claude", ["--version"]);
    const ver = stdout.toString().trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
    if (compareVersions(ver, MIN_CLAUDE_VERSION) < 0) {
      return {
        name: "Claude Code",
        ok: false,
        detail: `found ${ver}, need >= ${MIN_CLAUDE_VERSION}`,
        fix: "Update Claude Code: claude update",
      };
    }
    return { name: "Claude Code", ok: true, detail: `v${ver}` };
  } catch {
    return {
      name: "Claude Code",
      ok: false,
      detail: "`claude` not found on PATH",
      fix: "Install Claude Code and log in: https://claude.com/claude-code",
    };
  }
}

/**
 * Informational, never a failure — an old Claude Code just runs live turn view
 * without narration (tool/agent rows are unaffected). Unparseable `--version`
 * output is skipped rather than warned: unknown is not "below floor".
 */
export async function checkLiveViewVersion(run: RunLike = defaultRun): Promise<CheckResult> {
  let stdout: string;
  try {
    stdout = (await run("claude", ["--version"])).stdout.toString();
  } catch {
    // claude missing on PATH is already reported by the Claude Code check above.
    return { name: "Live turn view", ok: true, skipped: true, detail: "could not run `claude --version`" };
  }
  const ver = parseClaudeVersion(stdout);
  if (ver === null) {
    return { name: "Live turn view", ok: true, skipped: true, detail: "could not parse `claude --version` output — skipping the live-turn-view check" };
  }
  if (isBelowVersion(ver, MIN_LIVE_VIEW_VERSION)) {
    return {
      name: "Live turn view",
      ok: true,
      skipped: true,
      detail: `Claude Code ${ver} — live turn view narration requires >= ${MIN_LIVE_VIEW_VERSION} (MessageDisplay hook); tool/agent rows still work without it`,
    };
  }
  return { name: "Live turn view", ok: true, detail: `Claude Code ${ver} — live turn view narration supported` };
}

const TIMED_OUT = Symbol("doctor-check-timed-out");

/** Races `promise` against a timer; resolves to the TIMED_OUT sentinel instead of hanging forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // A readToken that eventually settles after we've already timed out is
    // simply ignored — readAccessToken always resolves (it catches its own
    // errors), so there's nothing here that can produce an unhandled rejection.
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(TIMED_OUT); },
    );
  });
}

export async function checkClaudeLogin(
  readToken: () => Promise<string | null> = readAccessToken,
  timeoutMs: number = LOGIN_CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  const token = await withTimeout(readToken(), timeoutMs);
  if (token === TIMED_OUT) {
    return {
      name: "Claude Code login",
      ok: false,
      detail: `could not check (keychain timeout after ${timeoutMs}ms)`,
      fix: "Unlock your keychain (macOS) or check ~/.claude/.credentials.json, then re-run `teleclaude doctor`",
    };
  }
  if (token) return { name: "Claude Code login", ok: true, detail: "OAuth credentials found" };
  return {
    name: "Claude Code login",
    ok: false,
    detail: "no OAuth credentials (keychain / ~/.claude/.credentials.json)",
    fix: "Run `claude` once and log in with your Pro/Max account",
  };
}

type FetchLike = (url: string) => Promise<Response>;
const defaultFetch: FetchLike = (url) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export async function checkBotToken(
  token: string | null,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CheckResult> {
  if (!token) {
    return {
      name: "Telegram bot token",
      ok: false,
      detail: "~/.teleclaude/bot_token missing",
      fix: "Run `teleclaude setup`",
    };
  }
  try {
    const json = (await (await fetchImpl(`https://api.telegram.org/bot${token}/getMe`)).json()) as {
      ok: boolean;
      result?: { username?: string; id?: number };
      description?: string;
    };
    if (json.ok) {
      return { name: "Telegram bot token", ok: true, detail: `valid — bot is @${json.result?.username ?? "?"}` };
    }
    return {
      name: "Telegram bot token",
      ok: false,
      detail: `getMe rejected: ${json.description ?? "unauthorized"}`,
      fix: "Re-run `teleclaude setup` with a fresh token from @BotFather",
    };
  } catch {
    return {
      name: "Telegram bot token",
      ok: false,
      detail: "could not reach api.telegram.org",
      fix: "Check internet connectivity, then retry",
    };
  }
}

export function checkOwners(configDir?: string): CheckResult {
  const ids = authorizedIds(loadConfig(configDir));
  if (!ids.length) {
    return {
      name: "Authorized users",
      ok: false,
      detail: "ownerTelegramIds is empty — every incoming message will be silently ignored",
      fix: "Run `teleclaude setup` and enter your numeric Telegram ID (message @userinfobot to get it)",
    };
  }
  return { name: "Authorized users", ok: true, detail: `${ids.length} authorized: ${ids.join(", ")}` };
}

export async function checkGroups(
  token: string | null,
  configDir?: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CheckResult[]> {
  const chatIds = [
    ...new Set(loadProjects(configDir).projects.map((p) => p.chatId).filter((c): c is number => c != null)),
  ];
  if (!chatIds.length) {
    return [
      { name: "Telegram groups", ok: true, skipped: true, detail: "no projects yet — groups are checked once /new creates one" },
    ];
  }
  if (!token) {
    return [{ name: "Telegram groups", ok: true, skipped: true, detail: "no bot token to check with" }];
  }
  const api = async (method: string) =>
    (await (await fetchImpl(`https://api.telegram.org/bot${token}/${method}`)).json()) as {
      ok: boolean;
      result?: any;
      description?: string;
    };
  let me: { ok: boolean; result?: any; description?: string };
  try {
    me = await api("getMe");
  } catch {
    return [{ name: "Telegram groups", ok: false, detail: "could not reach api.telegram.org", fix: "Check internet connectivity, then retry" }];
  }
  if (!me.ok) {
    return [{ name: "Telegram groups", ok: false, detail: "getMe failed — fix the bot token first", fix: "See the bot-token check above" }];
  }
  const results: CheckResult[] = [];
  for (const chatId of chatIds) {
    try {
      const member = await api(`getChatMember?chat_id=${chatId}&user_id=${me.result.id}`);
      const m = member.ok ? member.result : null;
      const admin = m?.status === "administrator" || m?.status === "creator";
      const topics = admin && m?.can_manage_topics !== false;
      results.push({
        name: `Group ${chatId}`,
        ok: Boolean(admin && topics),
        detail: !member.ok
          ? `unreachable: ${member.description ?? "unknown"}`
          : !admin
            ? `bot is "${m?.status}", not an admin`
            : !topics
              ? "admin, but missing the Manage Topics permission"
              : "bot is admin with Manage Topics",
        fix: admin && topics ? undefined : "In the group settings, promote the bot to admin and enable Manage Topics",
      });
    } catch {
      results.push({ name: `Group ${chatId}`, ok: false, detail: "network error", fix: "Check connectivity, then retry" });
    }
  }
  return results;
}

export function checkProjectPaths(configDir?: string): CheckResult {
  const projects = loadProjects(configDir).projects;
  if (!projects.length) return { name: "Project paths", ok: true, skipped: true, detail: "no projects yet" };
  const missing = projects.filter((p) => !existsSync(p.path));
  if (missing.length) {
    return {
      name: "Project paths",
      ok: false,
      detail: `missing: ${missing.map((p) => `${p.name} (${p.path})`).join(", ")}`,
      fix: "Restore the directory, or remove the project with /delete <name>",
    };
  }
  return { name: "Project paths", ok: true, detail: `${projects.length} project dir(s) exist` };
}

const OPTIONAL_DEPS = [
  { bin: "whisper-cli", feature: "voice transcription" },
  { bin: "ffmpeg", feature: "voice transcription" },
  { bin: "adb", feature: "the android emulator tool" },
  { bin: "idb", feature: "the ios simulator tool" },
];

export async function checkOptionalDeps(run: RunLike = defaultRun): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const { bin, feature } of OPTIONAL_DEPS) {
    try {
      await run("which", [bin]);
      out.push({ name: `optional: ${bin}`, ok: true, detail: "found" });
    } catch {
      out.push({ name: `optional: ${bin}`, ok: true, skipped: true, detail: `not found — ${feature} disabled (fine if unused)` });
    }
  }
  return out;
}

/**
 * Deliberately NOT probed: a real check needs a PTY spawn of Claude Code
 * against a project dir (~10s, burns a session start, and replays the whole
 * startup-dialog dance). The runtime already detects a block on every spawn
 * (channel-detect.ts banner scan) and alerts the topic + DMs the owner, so
 * doctor documents where that alert will come from instead of duplicating it.
 */
export function channelsPolicyNote(): CheckResult {
  return {
    name: "Org channels policy",
    ok: true,
    skipped: true,
    detail: "not probed — the first project spawn detects an org-policy block and alerts you in Telegram",
    fix: "If topics never answer: have an org admin enable channelsEnabled at claude.ai/admin-settings/claude-code",
  };
}

/**
 * Read-only, live-daemon-safe: no PTY spawns, no service restarts, no writes
 * to ~/.teleclaude. The bot-token/group checks are harmless Telegram API GETs.
 */
export async function runDoctor(
  configDir?: string,
  botToken?: string | null,
): Promise<{ results: CheckResult[]; ok: boolean }> {
  const token = botToken ?? null;
  const results: CheckResult[] = [
    checkNodeVersion(),
    await checkClaudeCli(),
    await checkLiveViewVersion(),
    await checkClaudeLogin(),
    await checkBotToken(token),
    checkOwners(configDir),
    ...(await checkGroups(token, configDir)),
    checkProjectPaths(configDir),
    ...(await checkOptionalDeps()),
    channelsPolicyNote(),
  ];
  return { results, ok: results.every((r) => r.ok) };
}

export function formatResults(results: CheckResult[]): string {
  return results
    .map((r) => {
      const icon = r.skipped ? "⏭" : r.ok ? "✅" : "❌";
      const fix = !r.ok && r.fix ? `\n   fix: ${r.fix}` : "";
      return `${icon} ${r.name} — ${r.detail}${fix}`;
    })
    .join("\n");
}
