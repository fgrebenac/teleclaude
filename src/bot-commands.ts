import type { Bot } from "grammy";
import type { BotCommandScope } from "grammy/types";
import { loadConfig, loadProjects, authorizedIds, type Project } from "./config.js";
import { normalizeRouteName } from "./commands.js";
import { log, logError } from "./log.js";

/**
 * Populates Telegram's command menu (the blue Menu button and the `/`
 * autocomplete) via setMyCommands. Purely cosmetic — every command works
 * whether or not it's registered here — but without it there's no autocomplete
 * at all.
 *
 * Telegram picks the MOST SPECIFIC scope that has a list, so a chat-scoped list
 * must be complete: the per-chat lists below are "everything for that chat type"
 * plus that chat's project shortcuts.
 */

export interface BotCommand {
  command: string;
  description: string;
}

/** Telegram's rule for a command name. */
const VALID_COMMAND = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_COMMANDS = 100;
const MAX_DESCRIPTION = 256;

/** Commands usable in the General topic / a DM. */
export const GENERAL_COMMANDS: BotCommand[] = [
  { command: "help", description: "Commands (/help schedule for scheduling)" },
  { command: "list", description: "Projects in this group (🟢 = running)" },
  { command: "new", description: "Create a project: /new <name> <path>" },
  { command: "ls", description: "Browse the filesystem to create a project" },
  { command: "delete", description: "Delete a project and its topic" },
  { command: "at", description: "Schedule a one-off run: /at 07:00 <project> <msg>" },
  { command: "every", description: "Schedule a recurring run: /every day 07:00 …" },
  { command: "schedules", description: "List schedules, with cancel buttons" },
  { command: "unschedule", description: "Cancel a schedule by id" },
  { command: "status", description: "Version, uptime, running sessions" },
  { command: "usage", description: "Token usage and quota" },
  { command: "update", description: "Pull the latest version and restart" },
  { command: "restart", description: "Restart the bot service" },
];

/** Commands usable inside a project topic. */
export const PROJECT_COMMANDS: BotCommand[] = [
  { command: "new", description: "Fresh session for this topic: /new [name]" },
  { command: "stop", description: "Stop this topic's session" },
  { command: "cancel", description: "Interrupt the in-flight turn (best-effort)" },
  { command: "rename", description: "Name this session: /rename <name>" },
  { command: "model", description: "Switch model (persisted)" },
  { command: "effort", description: "Switch reasoning effort (persisted)" },
  { command: "permissions", description: "Auto / Supervised / Bypass (persisted)" },
  { command: "live", description: "Live turn view: full / summary / off" },
  { command: "notify", description: "Toggle 💬 notification when a turn finishes" },
  { command: "status", description: "Session status, model, permissions" },
  { command: "usage", description: "Tokens and context window" },
  { command: "sessions", description: "Recent sessions, with resume buttons" },
  { command: "resume", description: "Resume a session: /resume <id>" },
  { command: "handoff", description: "Hand this session to your terminal" },
  { command: "screenshot", description: "Screenshot a URL" },
  { command: "diff", description: "Uncommitted git changes: summary + patch file" },
  { command: "review", description: "Toggle turn-end prompt on uncommitted changes" },
  { command: "webhook", description: "Inbound webhook for this topic: /webhook [new|off]" },
  { command: "receipts", description: "Toggle a one-line receipt after each turn" },
  { command: "pin", description: "Toggle the pinned session-name message" },
  { command: "at", description: "Schedule a one-off run here: /at 07:00 <msg>" },
  { command: "every", description: "Schedule a recurring run here" },
  { command: "digest", description: "Recurring briefing presets: /digest [HH:MM]" },
  { command: "schedules", description: "Schedules for this topic" },
  { command: "help", description: "Commands (/help schedule for scheduling)" },
];

/** Merge lists, first description wins for a duplicate command name. */
export function mergeCommands(...lists: BotCommand[][]): BotCommand[] {
  const seen = new Map<string, BotCommand>();
  for (const list of lists) {
    for (const c of list) if (!seen.has(c.command)) seen.set(c.command, c);
  }
  return [...seen.values()];
}

/**
 * Descriptions for the names that exist in BOTH lists and mean different things
 * depending on which topic you type them in.
 *
 * Telegram has no topic-scoped command list (see groupCommands), so a forum
 * group shows one merged menu — and a plain merge silently keeps whichever
 * description came first, which is wrong half the time: "/new" read "Create a
 * project: /new <name> <path>" even in a project topic, where it starts a fresh
 * session. These spell out both meanings instead of picking one.
 */
export const GROUP_MERGED_DESCRIPTIONS: Record<string, string> = {
  new: "Topic: fresh session /new [name] · General: /new <name> <path>",
  status: "Topic: session status · General: version, uptime, running sessions",
  usage: "Topic: context window + session tokens · General: weekly usage",
  at: "One-off run · Topic: /at 07:00 <msg> · General: + <project>",
  every: "Recurring run · Topic: /every day 07:00 <msg> · General: + <project>",
  schedules: "Schedules · Topic: this topic's · General: the whole group's",
};

/**
 * A forum group needs one combined list: Telegram's command scopes are per chat
 * (or chat type) and have NO notion of a topic — there is no
 * BotCommandScope for one, and the `/` autocomplete a client shows inside a
 * topic is just the chat's list. So General-topic and project-topic commands
 * share the same menu, with dual descriptions for the overlap.
 */
export function groupCommands(): BotCommand[] {
  return mergeCommands(GENERAL_COMMANDS, PROJECT_COMMANDS).map((c) => {
    const merged = GROUP_MERGED_DESCRIPTIONS[c.command];
    return merged ? { ...c, description: merged } : c;
  });
}

/**
 * `/<project> <message>` shortcuts, so typing "/" offers the projects by name.
 * Skips names Telegram won't accept (after normalizing "-"→"_" and stripping
 * diacritics) and names that would shadow a real command — those lose to the
 * registered handler anyway, so offering them would be a lie.
 */
export function projectCommands(projects: Project[], reserved: Iterable<string>): BotCommand[] {
  const taken = new Set(reserved);
  const out: BotCommand[] = [];
  for (const p of projects) {
    const command = normalizeRouteName(p.name);
    if (!VALID_COMMAND.test(command)) {
      log(`[bot-commands] skipping project "${p.name}" — not a valid Telegram command name`);
      continue;
    }
    if (taken.has(command)) {
      log(`[bot-commands] skipping project "${p.name}" — /${command} already taken`);
      continue;
    }
    taken.add(command);
    out.push({ command, description: `→ ${p.name}: send a message to this project`.slice(0, MAX_DESCRIPTION) });
  }
  return out;
}

/** Base commands + that chat's project shortcuts, capped at Telegram's limit. */
export function commandsForChat(base: BotCommand[], projects: Project[]): BotCommand[] {
  const withProjects = [...base, ...projectCommands(projects, base.map((c) => c.command))];
  if (withProjects.length > MAX_COMMANDS) {
    log(`[bot-commands] ${withProjects.length} commands exceeds Telegram's ${MAX_COMMANDS} — truncating`);
  }
  return withProjects.slice(0, MAX_COMMANDS);
}

/**
 * Push every scope's list to Telegram. Safe to call repeatedly (it's a plain
 * overwrite, stored server-side) and never throws — a failed menu update must
 * not take the daemon down.
 */
export async function syncBotCommands(bot: Bot, configDir?: string): Promise<void> {
  const projects = loadProjects(configDir).projects;
  const owners = authorizedIds(loadConfig(configDir));

  const set = async (commands: BotCommand[], scope?: BotCommandScope) => {
    try {
      await bot.api.setMyCommands(commands, scope ? { scope } : undefined);
    } catch (err) {
      logError(`[bot-commands] setMyCommands failed for scope ${JSON.stringify(scope)}:`, err);
    }
  };

  // Broad fallbacks for chats we don't know about yet.
  await set(GENERAL_COMMANDS, { type: "all_private_chats" });
  await set(groupCommands(), { type: "all_group_chats" });
  await set(GENERAL_COMMANDS, undefined); // default scope

  // A DM can route to any project, so owners get the full project list.
  const dmCommands = commandsForChat(GENERAL_COMMANDS, projects);
  for (const owner of owners) {
    await set(dmCommands, { type: "chat", chat_id: owner });
  }

  // Each group gets its own projects only.
  const chatIds = [...new Set(projects.map((p) => p.chatId).filter((id): id is number => typeof id === "number"))];
  for (const chatId of chatIds) {
    const own = projects.filter((p) => p.chatId === chatId);
    await set(commandsForChat(groupCommands(), own), { type: "chat", chat_id: chatId });
  }

  log(`[bot-commands] menu synced — ${projects.length} project(s), ${owners.length} owner DM(s), ${chatIds.length} group(s)`);
}
