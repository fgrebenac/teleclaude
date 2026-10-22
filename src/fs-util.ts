import { writeFileSync, renameSync, chmodSync, readFileSync } from "fs";
import { logError } from "./log.js";

/**
 * Write JSON via temp-file + rename so a crash mid-write can never leave a
 * truncated file — a torn projects.json/config.json would crash-loop the
 * daemon under launchd, and a torn sessions.json silently drops all
 * session/model/permission state.
 *
 * 0600: state files hold session ids, chat ids, project paths and owner
 * Telegram ids — nothing another local user should read. rename() carries the
 * temp file's mode, so a pre-existing 0644 file tightens on its next write.
 * The explicit chmod covers a leftover .tmp from a crashed write, whose mode
 * writeFileSync's `mode` option would not change.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

/**
 * Parse a state file, preserving a corrupted original as <file>.corrupt-<ts>
 * instead of throwing — a torn write must not crash-loop the daemon, and the
 * next save must not silently overwrite evidence of what was lost. Returns
 * undefined for a missing OR corrupt file; callers that need to distinguish
 * should existsSync-check first. A missing file stays silent (nothing to
 * preserve, nothing to log); only a present-but-unparseable file is preserved
 * and logged.
 */
export function readJsonTolerant(file: string, label = "state"): any | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return undefined; // missing/unreadable — nothing to preserve, nothing to log
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, backup); } catch { /* best effort — still return undefined */ }
    logError(`[${label}] ${file} is corrupt — starting fresh, original saved as ${backup}`, err);
    return undefined;
  }
}
