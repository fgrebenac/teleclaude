import { mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { writeJsonAtomic, readJsonTolerant } from "./fs-util.js";
import { normalizeRouteName } from "./commands.js";

export interface Config {
  /** Legacy single-owner field. Kept for back-compat; merged into the authorized set. */
  ownerTelegramId: number;
  /** All Telegram user IDs allowed to use the bot (you, your partner, …). */
  ownerTelegramIds?: number[];
  showUsageStats: boolean;
  defaults: {
    /** Minutes of no reply + no active tool before the bot pings you with a force-stop. */
    stallAlertMinutes: number;
    /** DM owners when a quota bucket reaches this % (once per reset window). 0 disables. */
    quotaAlertPercent: number;
    /**
     * Spawn sessions with `--strict-mcp-config`, so a topic loads only our
     * channel server. `--mcp-config` is *additive*, so without this every topic
     * also inherits whatever MCP servers you have configured globally — which
     * makes a topic's tool surface depend on unrelated installs, adds auth and
     * elicitation surfaces nobody can answer from a phone, and can introduce a
     * new-server consent prompt that the spawn's timed-Enter sequence doesn't
     * expect. Set false if you deliberately want a global MCP server usable
     * from Telegram. Default true.
     */
    strictMcpConfig?: boolean;
    /**
     * Defer SCHEDULED runs (never interactive messages) while the 5h quota
     * bucket is at or above this %. 0 or unset disables. A gated job is pushed
     * 15 min at a time and its delivery attempts are never consumed; runs
     * resume automatically once utilization drops below the threshold.
     */
    schedulePauseAtPercent?: number;
    /**
     * After a session's first finished turn, ask Claude Code to name it from
     * the conversation (a bare `/rename`), so Telegram sessions show up in
     * `/sessions` and the terminal `/resume` picker by topic instead of as
     * `<dir>-<2hex>`. Skipped for sessions that already have a name. Default true.
     */
    autoNameSessions?: boolean;
  };
}

export interface Project {
  name: string;
  path: string;
  /** Telegram chat (group) the topic lives in. Topic IDs are only unique within a chat. */
  chatId?: number;
  topicId: number;
  createdAt: string;
}

/** Every Telegram user ID allowed to talk to the bot (legacy + list, de-duped). */
export function authorizedIds(config: Config): number[] {
  const ids = new Set<number>();
  if (config.ownerTelegramId) ids.add(config.ownerTelegramId);
  for (const id of config.ownerTelegramIds ?? []) if (id) ids.add(id);
  return [...ids];
}

export interface ProjectsFile {
  projects: Project[];
}

const DEFAULT_CONFIG: Config = {
  ownerTelegramId: 0,
  showUsageStats: true,
  defaults: { stallAlertMinutes: 5, quotaAlertPercent: 90, strictMcpConfig: true },
};

export function ensureDir(dir: string): void {
  // 0700: ~/.teleclaude holds the bot token and all state — no other local
  // user's business. Tighten an existing looser dir too (pre-hardening
  // installs created it 0755), best-effort.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* not ours to fix */ }
  }
}

function defaultDir(): string {
  return join(homedir(), ".teleclaude");
}

// --- In-memory caches ---

const configCache = new Map<string, Config>();
const projectsCache = new Map<string, ProjectsFile>();

export function loadConfig(dir?: string): Config {
  const d = dir ?? defaultDir();
  const cached = configCache.get(d);
  if (cached) return cached;

  const file = join(d, "config.json");
  if (!existsSync(file)) {
    const fresh = { ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults } };
    configCache.set(d, fresh);
    return fresh;
  }
  const loaded = readJsonTolerant(file, "config") ?? {};
  const config = {
    ...DEFAULT_CONFIG,
    ...loaded,
    defaults: { ...DEFAULT_CONFIG.defaults, ...loaded.defaults },
  };
  configCache.set(d, config);
  return config;
}

export function saveConfig(config: Config, dir?: string): void {
  const d = dir ?? defaultDir();
  ensureDir(d);
  writeJsonAtomic(join(d, "config.json"), config);
  configCache.set(d, config);
}

export function loadProjects(dir?: string): ProjectsFile {
  const d = dir ?? defaultDir();
  const cached = projectsCache.get(d);
  if (cached) return cached;

  const file = join(d, "projects.json");
  if (!existsSync(file)) {
    const fresh: ProjectsFile = { projects: [] };
    projectsCache.set(d, fresh);
    return fresh;
  }
  const data = readJsonTolerant(file, "config") ?? { projects: [] };
  if (!Array.isArray(data.projects)) data.projects = [];
  projectsCache.set(d, data);
  return data;
}

/**
 * Notified after any project add/remove/backfill. Lets the daemon refresh
 * Telegram's command menu (which lists projects) without every call site having
 * to remember to do it.
 */
let projectsChangedHook: (() => void) | undefined;

export function onProjectsChanged(hook: () => void): void {
  projectsChangedHook = hook;
}

export function saveProjects(projects: ProjectsFile, dir?: string): void {
  const d = dir ?? defaultDir();
  ensureDir(d);
  writeJsonAtomic(join(d, "projects.json"), projects);
  projectsCache.set(d, projects);
  try { projectsChangedHook?.(); } catch { /* a listener must not break persistence */ }
}

export function addProject(project: Project, dir?: string): void {
  const data = loadProjects(dir);
  data.projects.push(project);
  saveProjects(data, dir);
}

/** Remove a project by name within a chat (so the same name can exist in different groups). */
export function removeProject(chatId: number, name: string, dir?: string): void {
  const data = loadProjects(dir);
  data.projects = data.projects.filter((p) => !(p.name === name && projectInChat(p, chatId)));
  saveProjects(data, dir);
}

/** True if a project belongs to the given chat (legacy projects with no chatId match any). */
function projectInChat(p: Project, chatId: number): boolean {
  return p.chatId === chatId || p.chatId === undefined;
}

/**
 * Resolve a project by its (chat, topic) pair. Topic IDs are only unique within a
 * chat, so both are required. Falls back to a chatId-less legacy project with the
 * same topic id (pre-migration self-heal).
 */
export function getProject(chatId: number, topicId: number, dir?: string): Project | undefined {
  const data = loadProjects(dir);
  return data.projects.find((p) => p.topicId === topicId && p.chatId === chatId)
    ?? data.projects.find((p) => p.topicId === topicId && p.chatId === undefined);
}

/** Find a project by name within a chat. */
export function getProjectByName(chatId: number, name: string, dir?: string): Project | undefined {
  const data = loadProjects(dir);
  return data.projects.find((p) => p.name === name && projectInChat(p, chatId));
}

/**
 * A project whose name collides with `name` once folded to a command name
 * ("Garden-Web" vs "garden_web", "Café" vs "Cafe"). Such a pair is
 * indistinguishable to `/<project>` routing and can only appear once in
 * Telegram's command menu, so creation should refuse it.
 */
export function findRouteCollision(name: string, dir?: string): Project | undefined {
  const wanted = normalizeRouteName(name);
  return loadProjects(dir).projects.find((p) => p.name !== name && normalizeRouteName(p.name) === wanted);
}

/** All projects registered in a chat (group). */
export function getProjectsForChat(chatId: number, dir?: string): Project[] {
  const data = loadProjects(dir);
  return data.projects.filter((p) => projectInChat(p, chatId));
}

/**
 * Self-heal a legacy project that has no chatId: the first time a message is
 * resolved for its topic, stamp the chat so it auto-spawns on boot and the
 * `getProject` legacy fallback can eventually be removed. No-op if already set.
 * Returns true if a project was healed.
 */
export function backfillProjectChat(chatId: number, topicId: number, dir?: string): boolean {
  const data = loadProjects(dir);
  const p = data.projects.find((x) => x.topicId === topicId && x.chatId === undefined);
  if (!p) return false;
  p.chatId = chatId;
  saveProjects(data, dir);
  return true;
}

/** Clear caches (for testing). */
export function clearConfigCache(): void {
  configCache.clear();
  projectsCache.clear();
  projectsChangedHook = undefined;
}
