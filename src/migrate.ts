import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "./log.js";
import { writeJsonAtomic } from "./fs-util.js";

function defaultDir(): string {
  return join(homedir(), ".teleclaude");
}

/**
 * Migrate state from the old topic-id-only keying to composite (chatId:topicId) keys.
 *
 * Old layout:
 *   sessions.json: { "<topicId>": { chatId, sessionId, ... } }
 *   projects.json: { projects: [{ name, path, topicId }] }   // no chatId
 *
 * New layout:
 *   sessions.json: { "<chatId>:<topicId>": { chatId, sessionId, ... } }
 *   projects.json: { projects: [{ name, path, chatId, topicId }] }
 *
 * Idempotent: keys already containing ":" are left untouched, and projects that
 * already have a chatId are not modified.
 */
export function migrateToCompositeKeys(dir?: string): void {
  const d = dir ?? defaultDir();
  const sessionsPath = join(d, "sessions.json");
  const projectsPath = join(d, "projects.json");

  // Read old sessions to learn the topicId -> chatId mapping.
  let sessions: Record<string, any> = {};
  try { sessions = JSON.parse(readFileSync(sessionsPath, "utf-8")); } catch { sessions = {}; }

  const topicToChat = new Map<number, number>();
  const distinctChats = new Set<number>();
  for (const [key, entry] of Object.entries(sessions)) {
    if (key.includes(":")) {
      const chatId = Number(key.split(":")[0]);
      if (!Number.isNaN(chatId)) distinctChats.add(chatId);
      continue; // already migrated
    }
    const topicId = Number(key);
    const chatId = entry?.chatId;
    if (!Number.isNaN(topicId) && typeof chatId === "number") {
      topicToChat.set(topicId, chatId);
      distinctChats.add(chatId);
    }
  }
  // If every known session points at a single chat, use it as the fallback for
  // anything we can't otherwise resolve (the common single-group upgrade case).
  const soleChat = distinctChats.size === 1 ? [...distinctChats][0] : undefined;

  // --- Migrate sessions.json: re-key plain topic ids to composite keys ---
  let sessionsChanged = false;
  const newSessions: Record<string, any> = {};
  for (const [key, entry] of Object.entries(sessions)) {
    if (key.includes(":")) { newSessions[key] = entry; continue; }
    const topicId = Number(key);
    const chatId = (typeof entry?.chatId === "number" ? entry.chatId : undefined) ?? soleChat;
    if (chatId === undefined || Number.isNaN(topicId)) {
      // Can't determine the chat — keep as-is so nothing is lost.
      newSessions[key] = entry;
      log(`[migrate] session topic=${key} has no chatId — left under legacy key`);
      continue;
    }
    const composite = `${chatId}:${topicId}`;
    if (composite in sessions) {
      // A migrated entry for this pair already exists — the stale legacy key
      // must not overwrite it. Drop the legacy duplicate instead.
      log(`[migrate] dropping stale legacy key ${key} — ${composite} already exists`);
    } else {
      newSessions[composite] = { ...entry, chatId };
    }
    sessionsChanged = true;
  }
  if (sessionsChanged) {
    writeJsonAtomic(sessionsPath, newSessions);
    log(`[migrate] re-keyed sessions.json to composite keys`);
  }

  // --- Backfill project.chatId ---
  if (existsSync(projectsPath)) {
    let projectsFile: any = {};
    try { projectsFile = JSON.parse(readFileSync(projectsPath, "utf-8")); } catch { projectsFile = {}; }
    const projects: any[] = Array.isArray(projectsFile.projects) ? projectsFile.projects : [];
    let projectsChanged = false;
    for (const p of projects) {
      if (typeof p.chatId === "number") continue;
      const chatId = topicToChat.get(Number(p.topicId)) ?? soleChat;
      if (chatId !== undefined) {
        p.chatId = chatId;
        projectsChanged = true;
        log(`[migrate] backfilled project=${p.name} topic=${p.topicId} chatId=${chatId}`);
      } else {
        log(`[migrate] project=${p.name} topic=${p.topicId} — could not determine chatId`);
      }
    }
    if (projectsChanged) {
      writeJsonAtomic(projectsPath, { ...projectsFile, projects });
      log(`[migrate] backfilled chatId on projects.json`);
    }
  }
}

/**
 * Write-back for the legacy `bypass` boolean (pre-auto-mode /bypass command):
 * convert it to the equivalent `permissionMode` and drop the field. This is
 * exactly what resolvePermissionMode (permission-mode.ts) already does at read
 * time — true → "bypass", false → "default" (both were explicit choices), and
 * an entry that already has a permissionMode just loses the shadowed boolean —
 * so behavior is unchanged. Runs at boot BEFORE loadSessionState, so once
 * every install has booted this version, the read fallbacks
 * (resolvePermissionMode's bypass branch + SessionEntry.bypass) can be deleted
 * in a follow-up release. Returns the number of entries converted.
 */
export function migrateBypassBoolean(dir?: string): number {
  const d = dir ?? defaultDir();
  const sessionsPath = join(d, "sessions.json");
  let sessions: Record<string, any> = {};
  try { sessions = JSON.parse(readFileSync(sessionsPath, "utf-8")); } catch { return 0; }
  let converted = 0;
  for (const entry of Object.values(sessions)) {
    if (typeof entry?.bypass !== "boolean") continue;
    if (!entry.permissionMode) entry.permissionMode = entry.bypass ? "bypass" : "default";
    delete entry.bypass;
    converted++;
  }
  if (converted > 0) {
    writeJsonAtomic(sessionsPath, sessions);
    log(`[migrate] converted ${converted} legacy bypass boolean(s) to permissionMode`);
  }
  return converted;
}

export interface LegacyStateCounts {
  /** sessions.json keys still in the old topic-id-only form (no ":"). */
  legacySessionKeys: number;
  /** Session entries still carrying the pre-auto-mode `bypass` boolean. */
  bypassFields: number;
  /** Projects with no chatId (pre-composite-key layout). */
  chatlessProjects: number;
}

/**
 * Count every legacy artifact the migration read paths still exist for. Logged
 * once per boot: a release whose boots consistently report zeros is the
 * evidence that lets the FOLLOWING release delete migrateToCompositeKeys, the
 * bypass read fallback, and config.ts's chatId-less project fallbacks
 * (projectInChat's undefined match, getProject's legacy .find,
 * backfillProjectChat). Deletion is deliberately deferred — see CLAUDE.md.
 */
export function countLegacyState(dir?: string): LegacyStateCounts {
  const d = dir ?? defaultDir();
  let sessions: Record<string, any> = {};
  try { sessions = JSON.parse(readFileSync(join(d, "sessions.json"), "utf-8")); } catch { sessions = {}; }
  let projects: any[] = [];
  try {
    const parsed = JSON.parse(readFileSync(join(d, "projects.json"), "utf-8"));
    if (Array.isArray(parsed?.projects)) projects = parsed.projects;
  } catch { projects = []; }
  return {
    legacySessionKeys: Object.keys(sessions).filter((k) => !k.includes(":")).length,
    bypassFields: Object.values(sessions).filter((e) => typeof e?.bypass === "boolean").length,
    chatlessProjects: projects.filter((p) => typeof p?.chatId !== "number").length,
  };
}
