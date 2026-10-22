import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { log, logError } from "./log.js";
import { writeJsonAtomic } from "./fs-util.js";

const execFileP = promisify(execFile);

const PLIST_PATH = join(homedir(), "Library/LaunchAgents/com.teleclaude.bot.plist");
const SYSTEMD_PATH = join(homedir(), ".config/systemd/user/teleclaude.service");

/** Repo root — same convention as version.ts. */
function projectRoot(): string {
  return join(import.meta.dirname, "..");
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd: projectRoot() });
  return stdout.toString().trim();
}

export interface UpdateCheck {
  ok: boolean;
  reason?: string;
  /** Commits behind origin (0 = up to date). */
  behind: number;
}

/**
 * Pre-flight for a chat-triggered update: clean tree + how far behind origin.
 * A bundled build without a .git checkout has nothing to pull and refuses.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!existsSync(join(projectRoot(), ".git"))) {
    return { ok: false, reason: "not a git checkout — reinstall a newer build instead", behind: 0 };
  }
  try {
    const dirty = await git(["status", "--porcelain"]);
    if (dirty) return { ok: false, reason: "working tree has uncommitted changes — commit/stash them first", behind: 0 };
    await git(["fetch", "--quiet"]);
    const behind = Number(await git(["rev-list", "--count", "HEAD..@{upstream}"])) || 0;
    return { ok: true, behind };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `git failed: ${msg.slice(0, 200)}`, behind: 0 };
  }
}

/**
 * Pull + install. Runs inside the live daemon; the caller restarts afterwards.
 */
export async function runUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(join(projectRoot(), ".git"))) {
    return { ok: false, error: "not a git checkout — reinstall a newer build instead" };
  }
  try {
    log(`[self-update] git pull --ff-only`);
    await git(["pull", "--ff-only"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `git pull failed: ${msg.slice(0, 300)}` };
  }
  try {
    log(`[self-update] npm install`);
    await execFileP("npm", ["install"], { cwd: projectRoot(), timeout: 5 * 60_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Code is already pulled — a later KeepAlive restart would boot it with
    // stale deps, so the caller must surface this loudly.
    return { ok: false, error: `npm install failed (code already pulled — run "npm install" manually before restarting): ${msg.slice(0, 300)}` };
  }
  return { ok: true };
}

/**
 * Restart the installed service from INSIDE the daemon. The restart command is
 * spawned detached (own session, no stdio) with a short delay, so it survives
 * the daemon it is about to kill and our confirmation reply reaches Telegram
 * first. Returns false when no service is installed (foreground run).
 */
export function detachedServiceRestart(): boolean {
  let cmd: string;
  if (platform() === "darwin" && existsSync(PLIST_PATH)) {
    const uid = process.getuid?.() ?? 501;
    cmd = `launchctl kickstart -k gui/${uid}/com.teleclaude.bot`;
  } else if (platform() === "linux" && existsSync(SYSTEMD_PATH)) {
    cmd = "systemctl --user restart teleclaude";
  } else {
    return false;
  }
  log(`[self-update] scheduling detached restart: ${cmd}`);
  try {
    const child = spawn("/bin/sh", ["-c", `sleep 2 && ${cmd}`], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (err) {
    logError(`[self-update] failed to spawn detached restart`, err);
    return false;
  }
}

// --- Restart marker: lets the freshly-booted daemon confirm back into the chat ---

export interface RestartMarker {
  chatId: number;
  topicId?: number;
  note: string;
  at: number;
}

const MARKER_MAX_AGE_MS = 15 * 60_000;

function markerPath(configDir?: string): string {
  return join(configDir ?? join(homedir(), ".teleclaude"), "restart-notify.json");
}

export function writeRestartMarker(marker: RestartMarker, configDir?: string): void {
  try {
    writeJsonAtomic(markerPath(configDir), marker);
  } catch (err) {
    logError(`[self-update] failed to write restart marker`, err);
  }
}

/** Read-and-delete the marker; null if absent, unreadable, or stale. */
export function consumeRestartMarker(configDir?: string): RestartMarker | null {
  const p = markerPath(configDir);
  let marker: RestartMarker | null = null;
  try {
    marker = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
  try { unlinkSync(p); } catch { /* ignore */ }
  if (!marker || typeof marker.chatId !== "number" || typeof marker.at !== "number") return null;
  if (Date.now() - marker.at > MARKER_MAX_AGE_MS) return null;
  return marker;
}
