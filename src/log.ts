import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Log lives under ~/.teleclaude (0700) — it contains conversation content and
// tool commands, which must not sit world-readable in /tmp.
const LOG_DIR = join(homedir(), ".teleclaude", "logs");
export const LOG_PATH = join(LOG_DIR, "teleclaude.log");

const MAX_LOG_BYTES = 10 * 1024 * 1024; // rotate at 10MB, keep one previous file
const SIZE_CHECK_EVERY = 200; // writes between statSync size checks

// Tests import modules that log; don't pollute the real daemon log file.
const SILENT = process.env.VITEST === "true" || process.env.TELECLAUDE_SILENT === "1";

let dirReady = false;
let writesSinceCheck = SIZE_CHECK_EVERY; // check size on the first write too

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(line: string): void {
  try {
    if (!dirReady) {
      mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      dirReady = true;
    }
    if (++writesSinceCheck > SIZE_CHECK_EVERY) {
      writesSinceCheck = 0;
      try {
        if (statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`);
      } catch { /* no file yet */ }
    }
    appendFileSync(LOG_PATH, line, { mode: 0o600 });
  } catch { /* ignore */ }
}

export function log(...args: unknown[]): void {
  if (SILENT) return;
  write(`[${timestamp()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
}

export function logError(...args: unknown[]): void {
  if (SILENT) return;
  write(`[${timestamp()}] ERROR: ${args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    return typeof a === "string" ? a : JSON.stringify(a);
  }).join(" ")}\n`);
}
