import { readdirSync, readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from "fs";
import { StringDecoder } from "string_decoder";
import { basename, join, relative } from "path";
import { homedir } from "os";
import { log } from "./log.js";
import { isPathInside } from "./path-containment.js";
import { REPLY_REMINDER } from "./channel-instructions.js";

/** Transcript lines are free-form JSON; callers probe fields with optional chaining. */
type TranscriptEntry = Record<string, any>;

/** Chunk size for the JSONL reader. Exposed only so tests can force boundary splits. */
export const JSONL_CHUNK_BYTES = 256 * 1024;

/**
 * Walk a JSONL transcript one entry at a time, without holding the file in memory.
 *
 * The previous approach was `readFileSync` + `content.split("\n")`, which for the
 * weekly aggregate meant ~250MB of transcripts as UTF-8 strings *plus* an array of
 * every line — measured at a 142MB heap spike on one `/usage`. It also forced a
 * 50MB-per-file skip to stay safe, which silently dropped big sessions out of the
 * usage numbers.
 *
 * Reads fixed-size chunks and yields complete lines, so peak memory is one chunk
 * plus the longest line regardless of file size. Decoding goes through
 * StringDecoder: a chunk boundary can land mid-character, and transcripts are full
 * of non-ASCII, so naive per-chunk `toString()` would corrupt them. Blank and
 * unparseable lines are skipped, as every caller did by hand.
 *
 * Returns false if the file couldn't be opened.
 */
export function forEachLine(
  filePath: string,
  onLine: (line: string) => void,
  chunkSize = JSONL_CHUNK_BYTES,
): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  const emit = onLine;
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      const bytes = readSync(fd, buf, 0, chunkSize, null);
      if (bytes === 0) break;
      pending += decoder.write(buf.subarray(0, bytes));
      // Slice once per chunk, not once per line: repeatedly reslicing the buffer
      // is quadratic, and a 256KB chunk holds over a thousand lines.
      let start = 0;
      for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n", start)) {
        emit(pending.slice(start, nl));
        start = nl + 1;
      }
      if (start > 0) pending = pending.slice(start);
    }
    pending += decoder.end();
    // Only a real trailing line, not the empty remainder left by a file that
    // ends in a newline — which is most of them.
    if (pending) emit(pending);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * As forEachLine, but parses each line as JSON and skips blank or unparseable
 * ones — which every caller used to do by hand. Use forEachLine directly when a
 * cheap substring test can reject most lines before paying for a parse.
 */
export function forEachJsonLine(
  filePath: string,
  onEntry: (entry: TranscriptEntry) => void,
  chunkSize = JSONL_CHUNK_BYTES,
): boolean {
  return forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    try {
      onEntry(JSON.parse(line));
    } catch { /* a partially written last line is normal on a live session */ }
  }, chunkSize);
}

export interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  /** Relative path from the project root to this session's actual cwd, for a
   *  session that ran in a worktree or arbitrary subfolder. Undefined for a
   *  root-homed session (the common case, and every session before this). */
  subpath?: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

/** Convert a project path to the Claude session directory name. */
export function projectDirName(projectPath: string): string {
  // Resolve symlinks — Claude Code uses the real path for session storage
  let resolved = projectPath;
  try { resolved = realpathSync(projectPath); } catch { /* use as-is */ }
  // Claude Code replaces every non-alphanumeric character, not just "/" —
  // e.g. /x/v2.1.0 → -x-v2-1-0. Matching only "/" made /sessions, /resume and
  // /usage silently find nothing for paths containing dots or unicode.
  return resolved.replace(/[^a-zA-Z0-9]/g, "-");
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface SessionHome {
  /** Absolute path to this home's `~/.claude/projects/<name>` directory. */
  dir: string;
  /** Path from the project root to this home's cwd, "" for the root itself. */
  subpath: string;
  /** The cwd this home represents (realpath'd where possible). */
  cwd: string;
}

interface HomesCacheEntry {
  homes: SessionHome[];
  expiresAt: number;
}
const homesCache = new Map<string, HomesCacheEntry>();
const HOMES_CACHE_TTL_MS = 60_000;

/** Test-only: forget every cached homes list. */
export function clearSessionHomesCache(): void {
  homesCache.clear();
}

// forEachLine has no built-in early-exit; readAnyTranscriptCwd only needs the
// FIRST cwd field in a transcript, so it throws this sentinel once found and
// catches it one frame up, rather than reading a possibly-large file to the
// end for nothing.
const CWD_FOUND = Symbol("cwd-found");

/** The `cwd` field from the first data line of the first readable .jsonl in a
 *  directory, or null if none carry one (empty dir, or none parse). */
function readAnyTranscriptCwd(dirPath: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const file of files) {
    let found: string | null = null;
    try {
      forEachLine(join(dirPath, file), (line) => {
        if (!line.trim()) return;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (entry && typeof entry.cwd === "string" && entry.cwd) {
          found = entry.cwd;
          throw CWD_FOUND;
        }
      });
    } catch (err) {
      if (err !== CWD_FOUND) throw err;
    }
    if (found) return found;
  }
  return null;
}

function transcriptExistsIn(dir: string, sessionId: string): boolean {
  try {
    return statSync(join(dir, `${sessionId}.jsonl`)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every Claude Code project-storage directory that belongs to this project
 * root: the root's own `~/.claude/projects/<dirName>` (always first, even
 * empty) plus any worktree/subfolder session whose recorded cwd verifies as
 * inside the root.
 *
 * Two-step scan: a cheap `readdirSync` filter on the dash-joined name prefix
 * (fast, but false-positives on a sibling project whose name happens to start
 * the same way — `teleclaude` vs `teleclaude-docs`), then an exact check that
 * reads the first `cwd` field out of any transcript in each candidate and
 * verifies real containment with `isPathInside`. Cached per root for 60s —
 * project directories appear rarely, so a stale negative for a minute is
 * harmless, and this scan runs on every `/sessions`.
 */
export function sessionHomes(projectRoot: string, now: number = Date.now()): SessionHome[] {
  const cached = homesCache.get(projectRoot);
  if (cached && cached.expiresAt > now) return cached.homes;

  const rootDirName = projectDirName(projectRoot);
  let rootReal = projectRoot;
  try {
    rootReal = realpathSync(projectRoot);
  } catch {
    /* project dir may not exist (yet, or anymore) — use as given */
  }

  const homes: SessionHome[] = [{ dir: join(CLAUDE_PROJECTS_DIR, rootDirName), subpath: "", cwd: rootReal }];

  let candidates: string[];
  try {
    candidates = readdirSync(CLAUDE_PROJECTS_DIR).filter(
      (name) => name !== rootDirName && name.startsWith(`${rootDirName}-`),
    );
  } catch {
    candidates = [];
  }

  for (const name of candidates) {
    const dirPath = join(CLAUDE_PROJECTS_DIR, name);
    let cwd: string | null;
    try {
      cwd = readAnyTranscriptCwd(dirPath);
    } catch {
      continue; // any other I/O throw skips this candidate rather than propagating
    }
    if (!cwd || !isPathInside(rootReal, cwd)) continue; // sibling false-positive, or unreadable
    homes.push({ dir: dirPath, subpath: relative(rootReal, cwd), cwd });
  }

  homesCache.set(projectRoot, { homes, expiresAt: now + HOMES_CACHE_TTL_MS });
  return homes;
}

/** Which home currently holds `<sessionId>.jsonl`, or null if none do. Always
 *  re-resolved dynamically (never cached per-session): Claude Code physically
 *  relocates a transcript's directory when a session runs ExitWorktree, so a
 *  session's home can change over its lifetime. */
export function resolveSessionHome(projectRoot: string, sessionId: string): { cwd: string } | null {
  for (const home of sessionHomes(projectRoot)) {
    if (transcriptExistsIn(home.dir, sessionId)) return { cwd: home.cwd };
  }
  return null;
}

/**
 * A user-set session name recorded in a transcript entry, or null.
 *
 * Claude Code writes the name three ways, all seen on 2.1.234 for a single
 * `/rename`, so all three are accepted and the last one in the file wins:
 *   {"type":"custom-title","customTitle":"api work", …}
 *   {"type":"agent-name","agentName":"api work", …}
 *   {"type":"system","subtype":"local_command","content":"<local-command-stdout>Session renamed to: api work</local-command-stdout>"}
 * The structured pair is the reliable signal; the stdout line is what older
 * transcripts have, and is kept so renames from before this landed still show.
 *
 * A name set with `claude -n` at launch appears in NONE of these — nothing is
 * written to the transcript for it — which is why teleclaude persists its own
 * copy per topic (see session-state.ts) instead of relying on this alone.
 */
export function sessionNameFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, any>;
  if (e.type === "custom-title" && typeof e.customTitle === "string" && e.customTitle.trim()) {
    return e.customTitle.trim();
  }
  if (e.type === "agent-name" && typeof e.agentName === "string" && e.agentName.trim()) {
    return e.agentName.trim();
  }
  if (e.type === "system" && e.subtype === "local_command" && typeof e.content === "string") {
    const m = e.content.match(/<local-command-stdout>Session renamed to: (.+?)<\/local-command-stdout>/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Claude Code's own auto-generated title (`{"type":"ai-title","aiTitle":…}`,
 * rewritten as the conversation evolves — last wins). It's what the terminal
 * `/resume` picker shows. Ranked below a user-set name. Not written for
 * channel-driven sessions (verified on 2.1.308: 0 records across teleclaude
 * transcripts), so Telegram-started sessions fall back to promptLabel.
 */
export function sessionTitleFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, any>;
  if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim()) return e.aiTitle.trim();
  return null;
}

/** Cheap prefilter: can this raw line possibly carry a session name? */
export function lineMayCarrySessionName(line: string): boolean {
  return line.includes("Session renamed to:")
    || line.includes('"custom-title"')
    || line.includes('"agent-name"')
    || line.includes('"ai-title"');
}

/** Wrappers Claude Code puts around non-prompt "user" entries (slash-command echoes, caveats). */
const NON_PROMPT_PREFIXES = ["<local-command-caveat>", "<command-name>", "<command-message>", "<local-command-stdout>", "<system-reminder>"];

/**
 * A readable label from a raw user-message text, or null when the entry
 * isn't a real prompt (so the caller keeps looking at the next one).
 * Unwraps the `<channel …>` envelope, drops the reply-tool reminder that the
 * first injected message carries, and shortens teleclaude's file-upload
 * prefix to the file name.
 */
export function promptLabel(raw: string, max = 80): string | null {
  let text = raw.trim();
  const channel = text.match(/<channel[^>]*>([\s\S]*)<\/channel>/);
  if (channel) text = channel[1].trim();
  if (text.startsWith(REPLY_REMINDER.trim())) text = text.slice(REPLY_REMINDER.trim().length).trim();
  if (!text || NON_PROMPT_PREFIXES.some((p) => text.startsWith(p))) return null;
  text = text.replace(/^\[File uploaded to ([^\]]+)\]/, (_m, p: string) => `📎 ${basename(p)}`);
  text = text.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** Scan a JSONL file for the last name the user set and Claude Code's last auto title. */
function readSessionNames(filePath: string): { name: string | null; title: string | null } {
  let name: string | null = null;
  let title: string | null = null;
  // Called once per session by listProjectSessions, so it reads a lot of files.
  // The substring test rejects almost every line for the price of a scan, which
  // is why this uses forEachLine rather than parsing each line as JSON.
  forEachLine(filePath, (line) => {
    if (!lineMayCarrySessionName(line)) return;
    try {
      const entry = JSON.parse(line);
      name = sessionNameFromEntry(entry) ?? name;
      title = sessionTitleFromEntry(entry) ?? title;
    } catch { /* skip */ }
  });
  return { name, title };
}

/** List every session transcript in one Claude Code project-storage
 *  directory. `subpath` ("" for the root) is attached to every SessionInfo
 *  returned so /sessions can render a `↳ <subpath>` label on non-root ones. */
function listSessionsInDir(sessionsDir: string, subpath: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  const indexedIds = new Set<string>();
  const label = subpath || undefined;

  // --- 1. Read sessions-index.json (AI-generated summaries, newer Claude Code) ---
  try {
    const indexPath = join(sessionsDir, "sessions-index.json");
    const indexContent = readFileSync(indexPath, "utf-8");
    const index = JSON.parse(indexContent);
    for (const entry of index.entries ?? []) {
      if (entry.isSidechain) continue;
      const mtime = entry.fileMtime ?? new Date(entry.modified ?? 0).getTime();
      const jsonlPath = join(sessionsDir, `${entry.sessionId}.jsonl`);
      const { name, title } = readSessionNames(jsonlPath);
      const baseSummary = entry.summary
        || (typeof entry.firstPrompt === "string" ? promptLabel(entry.firstPrompt) : null)
        || entry.sessionId.slice(0, 8);
      sessions.push({
        sessionId: entry.sessionId,
        summary: name ?? title ?? baseSummary,
        lastModified: mtime,
        subpath: label,
      });
      indexedIds.add(entry.sessionId);
    }
  } catch { /* no index file, fall through */ }

  // --- 2. Supplement with JSONL-only sessions not already indexed ---
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return sessions;
  }

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    if (indexedIds.has(sessionId)) continue;

    const filePath = join(sessionsDir, file);
    try {
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      let summary = sessionId.slice(0, 8);
      let renamed: string | null = null;
      let title: string | null = null;
      let foundPrompt = false;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.isSidechain) { summary = ""; break; }
          // Check for a user-set name (scan whole file, last wins)
          renamed = sessionNameFromEntry(entry) ?? renamed;
          title = sessionTitleFromEntry(entry) ?? title;
          // First real user prompt as the fallback label (slash-command echoes and
          // caveats are skipped by promptLabel returning null)
          if (!foundPrompt && entry.type === "user" && entry.message?.content) {
            const text = typeof entry.message.content === "string"
              ? entry.message.content
              : entry.message.content.find((b: any) => b.type === "text")?.text ?? "";
            const label = promptLabel(text);
            if (label) { summary = label; foundPrompt = true; }
          }
        } catch { /* skip */ }
      }

      const finalSummary = renamed ?? title ?? summary;
      if (finalSummary) {
        sessions.push({ sessionId, summary: finalSummary, lastModified: stat.mtimeMs, subpath: label });
      }
    } catch { /* skip unreadable files */ }
  }

  return sessions;
}

/** List recent sessions for a project, across the root AND any verified
 * worktree/subfolder home (see sessionHomes). Reads sessions-index.json first
 * (AI-named summaries), then supplements with any JSONL-only sessions not
 * covered by the index. In both cases, checks the JSONL for a /rename
 * override. */
export async function listProjectSessions(projectPath: string, limit = 10): Promise<SessionInfo[]> {
  const homes = sessionHomes(projectPath);
  const sessions: SessionInfo[] = [];
  for (const home of homes) {
    sessions.push(...listSessionsInDir(home.dir, home.subpath));
  }
  return sessions
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, limit);
}

/**
 * Whether a session's transcript still exists on disk.
 *
 * Claude Code's retention sweep (`cleanupPeriodDays`, 30 days by default) deletes
 * old transcripts, but teleclaude keeps the session id in sessions.json forever.
 * Resuming a swept id is FATAL — Claude Code prints "No conversation found with
 * session ID: …" and exits code=1 within seconds — and since the dead id is still
 * persisted, every retry dies identically. Callers must validate before passing
 * a stored id to `--resume`.
 */
/** Absolute path of a session's JSONL transcript (see projectDirName for the naming rule). */
export function sessionTranscriptPath(sessionId: string, projectPath: string): string {
  return join(homedir(), ".claude", "projects", projectDirName(projectPath), `${sessionId}.jsonl`);
}

export function sessionTranscriptExists(sessionId: string, projectPath: string): boolean {
  try {
    return statSync(sessionTranscriptPath(sessionId, projectPath)).isFile();
  } catch {
    return false;
  }
}

export interface WeeklyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  costUSD: number | null;
  periodDays: number;
}

/** Scan all project session files and aggregate usage for the past N days. */
export function getWeeklyUsage(days = 7): WeeklyUsage {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const projectsDir = join(homedir(), ".claude", "projects");

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turns = 0;
  let totalCost = 0;
  let hasCost = false;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, turns, costUSD: null, periodDays: days };
  }

  for (const dir of projectDirs) {
    const dirPath = join(projectsDir, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      // Quick check: skip files not modified in the period
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < cutoff) continue;
        // Memory is bounded by forEachJsonLine now, but this still runs
        // synchronously in the daemon's event loop, so an enormous transcript
        // would stall message handling on CPU alone. The cap is about time, not
        // memory — hence far higher than the old 50MB, which silently dropped
        // real sessions out of the totals.
        if (stat.size > 512 * 1024 * 1024) {
          log(`[usage] skipping ${file} (${Math.round(stat.size / 1024 / 1024)}MB — too large to aggregate)`);
          continue;
        }
      } catch { continue; }

      forEachJsonLine(filePath, (entry) => {
        if (!entry.timestamp) return;
        if (new Date(entry.timestamp).getTime() < cutoff) return;

        if (entry.costUSD != null) { totalCost += entry.costUSD; hasCost = true; }

        if (entry.type === "assistant" && entry.message?.usage) {
          const u = entry.message.usage;
          turns++;
          inputTokens += u.input_tokens ?? 0;
          outputTokens += u.output_tokens ?? 0;
          cacheReadTokens += u.cache_read_input_tokens ?? 0;
          cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        }
      });
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    turns,
    costUSD: hasCost ? totalCost : null,
    periodDays: days,
  };
}

export interface SessionUsage {
  messageCount: number;
  totalOutputTokens: number;
  totalInputTokens: number;    // sum of all input+cache across all turns (actual API usage)
  contextTokens: number;       // current context window size (last turn's total input)
  contextPercent: number;      // contextTokens / contextWindow * 100
  contextWindow: number;       // model's context window size (200K or 1M)
  model: string;
  costUSD: number | null;      // sum of per-message costs if available
}

/** Context window size for a model ID. The [1m] suffix marks 1M-context sessions. */
export function contextWindowFor(model: string): number {
  return model.includes("[1m]") ? 1_000_000 : 200_000;
}

/** Read usage stats from a session JSONL file. */
export function getSessionUsage(sessionId: string, projectPath: string): SessionUsage | null {
  const dirName = projectDirName(projectPath);
  const filePath = join(homedir(), ".claude", "projects", dirName, `${sessionId}.jsonl`);

  let messageCount = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;
  let contextTokens = 0;
  let model = "";
  let totalCost = 0;
  let hasCost = false;

  const read = forEachJsonLine(filePath, (entry) => {
      if (entry.costUSD != null) {
        totalCost += entry.costUSD;
        hasCost = true;
      }
      if (entry.type === "assistant" && entry.message) {
        const msg = entry.message;
        if (msg.model) model = msg.model;
        const u = msg.usage;
        if (u) {
          messageCount++;
          const inputThisTurn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          totalInputTokens += inputThisTurn;
          totalOutputTokens += u.output_tokens ?? 0;
          contextTokens = inputThisTurn; // updated each turn — last one wins
        }
      }
  });
  if (!read) return null;

  const contextWindow = contextWindowFor(model);
  return {
    messageCount,
    totalOutputTokens,
    totalInputTokens,
    contextTokens,
    contextPercent: Math.round((contextTokens / contextWindow) * 100),
    contextWindow,
    model,
    costUSD: hasCost ? totalCost : null,
  };
}

/** Strip <channel> wrapper from text. */
function stripChannel(text: string): string {
  const m = text.match(/<channel[^>]*>([\s\S]*)<\/channel>/);
  return m ? m[1].trim() : text;
}

/** Read recent user/assistant messages from a session file. */
export function getSessionMessages(sessionId: string, projectPath: string, limit = 10): SessionMessage[] {
  const dirName = projectDirName(projectPath);
  const filePath = join(homedir(), ".claude", "projects", dirName, `${sessionId}.jsonl`);

  const messages: SessionMessage[] = [];

  forEachJsonLine(filePath, (entry) => {
      if (entry.type === "user" && entry.message?.content) {
        let text = typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content.find((b: any) => b.type === "text")?.text ?? "";
        text = stripChannel(text);
        if (text) messages.push({ role: "user", text: text.slice(0, 200) });
      }

      if (entry.type === "assistant" && entry.message?.content) {
        const blocks = entry.message.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              messages.push({ role: "assistant", text: b.text.slice(0, 200) });
              break;
            }
          }
        }
      }
      // Only the last `limit` are returned, so don't let a long transcript grow
      // this without bound on the way there.
      if (messages.length > limit * 4) messages.splice(0, messages.length - limit);
  });

  // Return last N messages
  return messages.slice(-limit);
}
