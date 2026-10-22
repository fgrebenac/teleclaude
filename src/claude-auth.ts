import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logError } from "./log.js";

const execFileP = promisify(execFile);

// Hosts without Claude Code OAuth credentials (API-key-only) hit this on every
// /model and /usage — log the failure once, not forever.
let failureLogged = false;

/** Read the Claude Code OAuth access token (macOS keychain or ~/.claude/.credentials.json). */
export async function readAccessToken(): Promise<string | null> {
  try {
    if (platform() === "darwin") {
      const { stdout } = await execFileP("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      const parsed = JSON.parse(stdout);
      return parsed?.claudeAiOauth?.accessToken ?? null;
    }
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch (err) {
    if (!failureLogged) {
      failureLogged = true;
      logError("[claude-auth] readAccessToken failed (logged once):", err);
    }
    return null;
  }
}
