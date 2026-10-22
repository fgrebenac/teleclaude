import { readFileSync, writeFileSync, chmodSync, existsSync } from "fs";
import { join } from "path";
import { log } from "./log.js";

/** Claude Code hook events teleclaude installs, with the callback event name for each. */
export const TELECLAUDE_HOOK_EVENTS: [string, string][] = [
  ["StopFailure", "error"],
  ["Stop", "done"],
  // Auto mode blocks an action without asking anyone; the notice only lands in
  // the TUI and /permissions, neither of which exists on a phone. Forwarding it
  // is the only way the user learns their request was cut short.
  ["PermissionDenied", "permission_denied"],
  // An MCP server asking a human for form input would otherwise block the turn
  // on a dialog rendered in a PTY nobody is watching (elicitation.ts).
  ["Elicitation", "elicitation"],
  ["PreCompact", "compact"],
  ["PostCompact", "compacted"],
  ["TaskCreated", "task_created"],
  ["TaskCompleted", "task_completed"],
  ["PreToolUse", "tool_use"],
  ["PostToolUse", "tool_use_post"],
  // A tool that fails emits this instead of PostToolUse — without it the
  // stuck-tool watchdog's in-flight count never decrements for a failed call.
  ["PostToolUseFailure", "tool_failed"],
  ["SubagentStart", "subagent_start"],
  ["SubagentStop", "subagent_stop"],
  // Streams the assistant's message text as it's produced, so the topic can
  // show live narration instead of only the final reply.
  ["MessageDisplay", "narration"],
];

export interface HookEntry { matcher?: string; hooks?: { type?: string; url?: string; [k: string]: unknown }[] }
export type HooksConfig = Record<string, HookEntry[]>;

function isTeleclaudeEntry(entry: HookEntry | null | undefined, origin: string): boolean {
  return entry?.hooks?.some((h) => typeof h.url === "string" && h.url.startsWith(origin)) ?? false;
}

/**
 * The settings object teleclaude passes to its own spawn via `--settings`.
 *
 * These hooks used to be merged into the project's own
 * `.claude/settings.local.json`, which had three costs: it mutated a directory
 * teleclaude doesn't own, it wrote the spawn token (which doubles as the channel
 * server's HTTP auth) into a file inside a repo, and — worst — the hooks applied
 * to *every* Claude Code session in that directory, so the user's own terminal
 * sessions fired teleclaude's callbacks on every tool use. The daemon had to
 * recognise and reject those as foreign, and any hook key a later version stopped
 * installing was left behind to fire forever.
 *
 * `--settings` merges with the file-based sources rather than replacing them
 * (verified: a project-scope hook and a --settings hook for the same event both
 * fire), so the user's own hooks still run and ours are scoped to this process.
 */
export function teleclaudeHookSettings(callbackBase: string): { hooks: HooksConfig } {
  const hooks: HooksConfig = {};
  for (const [event, name] of TELECLAUDE_HOOK_EVENTS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "http", url: `${callbackBase}&event=${name}` }] }];
  }
  return { hooks };
}

/**
 * Prune dead teleclaude hooks from each project's `.claude/settings.local.json`.
 * Rewrites only files that actually changed, so this doesn't churn mtimes on
 * every boot. A project that can't be read or parsed is skipped, never
 * truncated — a settings file is the user's, and losing their hooks to repair
 * ours would be a bad trade.
 */
export function sweepProjectHooks(
  projectPaths: string[],
  origin: string,
): { scanned: number; changed: number; removed: number } {
  let scanned = 0, changed = 0, removed = 0;
  for (const projectPath of projectPaths) {
    const settingsPath = join(projectPath, ".claude", "settings.local.json");
    if (!existsSync(settingsPath)) continue;
    let settings: { hooks?: HooksConfig } & Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      log(`[hooks:sweep] skipping unparseable ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    scanned++;
    if (!settings.hooks || typeof settings.hooks !== "object") continue;

    const before = JSON.stringify(settings.hooks);
    const result = pruneTeleclaudeHooks(settings.hooks, origin);
    if (result.removed === 0 || JSON.stringify(result.hooks) === before) continue;

    if (Object.keys(result.hooks).length > 0) settings.hooks = result.hooks;
    else delete settings.hooks;
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
      chmodSync(settingsPath, 0o600);
      changed++;
      removed += result.removed;
      log(`[hooks:sweep] pruned ${result.removed} dead teleclaude hook(s) from ${settingsPath}`);
    } catch (err) {
      log(`[hooks:sweep] failed writing ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { scanned, changed, removed };
}

/**
 * Strip every teleclaude hook entry from a settings map, preserving user hooks.
 *
 * Now a migration: teleclaude no longer writes hooks into project settings at
 * all (see teleclaudeHookSettings), so anything a previous version left there is
 * dead weight that still fires on the user's own terminal sessions. Run at
 * startup, when no spawn is alive to own any of it.
 */
export function pruneTeleclaudeHooks(
  existing: HooksConfig | undefined,
  origin: string,
): { hooks: HooksConfig; removed: number } {
  const hooks: HooksConfig = { ...(existing ?? {}) };
  let removed = 0;
  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) continue;
    const kept = hooks[key].filter((e) => !isTeleclaudeEntry(e, origin));
    removed += hooks[key].length - kept.length;
    if (kept.length > 0) hooks[key] = kept;
    else delete hooks[key];
  }
  return { hooks, removed };
}
