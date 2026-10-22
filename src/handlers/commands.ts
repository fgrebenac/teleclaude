import { existsSync, unlinkSync } from "fs";
import { homedir } from "os";
import { Bot, InputFile } from "grammy";
import {
  addProject, removeProject, getProject,
  getProjectByName, getProjectsForChat, findRouteCollision,
} from "../config.js";
import { parseNewCommand, parseDeleteCommand, commandArgument } from "../commands.js";
import { isGeneralTopic, getTopicId, topicKey } from "../bot.js";
import { escapeHtml } from "../telegram-format.js";
import { takeScreenshot } from "../screenshot.js";
import { listProjectSessions, getSessionUsage, getWeeklyUsage, resolveSessionHome } from "../sessions.js";
import { getQuota, formatQuotaLines } from "../quota.js";
import { getTopicSession, updateTopicSession, spawnSettingsFor } from "../session-state.js";
import { LIVE_VIEW_MODES, type LiveViewMode } from "../turn-view.js";
import { postToTopic } from "../channel-post.js";
import { resumeSession } from "./resume.js";
import { log } from "../log.js";
import { requestCancel } from "../cancel.js";
import { requestRename, renameNotice } from "../rename.js";
import { maintainSessionPin, removeSessionPin } from "../session-pin.js";
import { sanitizeSessionName } from "../session-name.js";
import { readLiveSessionName } from "../claude-session-registry.js";
import { isSessionLiveElsewhere } from "../live-sessions.js";
import { preTrustWorkspace } from "../claude-trust.js";
import { buildHandoffMessage } from "../handoff.js";
import { fetchAvailableModels, resolveModel, curatedModels, supportedEffortLevels, findModelForValue } from "../models.js";
import { versionString } from "../version.js";
import { checkForUpdate } from "../self-update.js";
import type { ProcessManager } from "../processes.js";
import { sendLsListing } from "./ls.js";
import {
  PERMISSION_MODES, parsePermissionMode, permissionModeHelp, permissionModeLabel,
  permissionModeShort, resolvePermissionMode, type PermissionMode,
} from "../permission-mode.js";
import { removeTopicRuntime } from "../topic-runtime.js";
import { collectGitDiff, formatDiffHeader, diffCwdFor } from "../git-diff.js";
import { getWebhook, setWebhook, removeWebhook, newWebhookToken, webhookUrl, webhookCurlExample } from "../webhook.js";
import { renderDiffHtml } from "../diff-render.js";
import { DIFF_IMAGE_CALLBACK_DATA } from "../diff-image-callback.js";
import { renderHtmlToImages } from "../render-images.js";

/** Pending mkdir confirmations: chatId -> { name, path } */
export const pendingProjects = new Map<number, { name: string; path: string }>();

/** Persist the model choice and restart the topic's session with it. */
export async function switchModel(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
  projectPath: string,
  model: string,
): Promise<void> {
  log(`[model] topic=${topicId} switching to ${model}`);
  // Drop a persisted effort level the new model doesn't support
  const { models } = await fetchAvailableModels();
  const levels = supportedEffortLevels(findModelForValue(model, models));
  const savedEffort = getTopicSession(chatId, topicId)?.effort;
  const effort = savedEffort && levels.includes(savedEffort) ? savedEffort : undefined;
  if (savedEffort && !effort) log(`[model] topic=${topicId} clearing effort=${savedEffort} (unsupported by ${model})`);

  updateTopicSession(chatId, topicId, { model, effort });
  processManager.kill(chatId, topicId);
  processManager.spawn(chatId, topicId, projectPath, spawnSettingsFor(getTopicSession(chatId, topicId), { model, effort }));
}

/** Persist the effort choice (undefined = model default) and restart the session. */
export function switchEffort(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
  projectPath: string,
  effort: string | undefined,
): void {
  log(`[effort] topic=${topicId} switching to ${effort ?? "auto"}`);
  updateTopicSession(chatId, topicId, { effort });
  processManager.kill(chatId, topicId);
  processManager.spawn(chatId, topicId, projectPath, spawnSettingsFor(getTopicSession(chatId, topicId), { effort }));
}

/**
 * The mode a topic *is* in, or would start in. A stopped topic has no process to
 * ask, and ProcessManager answers with the global default for one — so consult
 * persisted state instead. Getting this wrong made /permissions report the wrong
 * current mode on a stopped topic.
 */
export function effectivePermissionMode(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
): PermissionMode {
  return processManager.isRunning(chatId, topicId)
    ? processManager.getPermissionMode(chatId, topicId)
    : resolvePermissionMode(getTopicSession(chatId, topicId));
}

/**
 * Persist a topic's permission mode and respawn. The mode is fixed at launch —
 * Claude Code won't let a session enter or leave bypass once started — so a
 * restart is the only way to apply it.
 */
export function switchPermissionMode(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
  projectPath: string,
  mode: PermissionMode,
): void {
  log(`[permissions] topic=${topicId} ${effectivePermissionMode(processManager, chatId, topicId)} → ${mode}`);
  // Clear the legacy boolean on the way through, so resolvePermissionMode stops
  // consulting it and a stale `bypass: true` can't resurface later.
  updateTopicSession(chatId, topicId, { permissionMode: mode, bypass: undefined });
  processManager.kill(chatId, topicId);
  processManager.spawn(chatId, topicId, projectPath, spawnSettingsFor(getTopicSession(chatId, topicId), { permissionMode: mode }));
}

export function parseLiveViewMode(arg: string): LiveViewMode | null {
  const v = arg.trim().toLowerCase();
  return v === "full" || v === "summary" || v === "off" ? v : null;
}

export function liveViewLabel(mode: LiveViewMode): string {
  switch (mode) {
    case "full": return "🔬 Full";
    case "summary": return "📋 Summary";
    case "off": return "🚫 Off";
  }
}

/**
 * Persist the live-view mode and, unlike /permissions/model/effort, push it to
 * the running channel server without a respawn — the setting is read at
 * startup (TELECLAUDE_LIVE_VIEW) but can also be flipped live via POST
 * /live-mode (see channel-server.ts). Skipped silently when nothing is
 * running: the next spawn picks up the persisted value from env anyway.
 */
export async function switchLiveView(
  processManager: ProcessManager,
  chatId: number,
  topicId: number,
  mode: LiveViewMode,
): Promise<void> {
  log(`[live] topic=${topicId} switching to ${mode}`);
  updateTopicSession(chatId, topicId, { liveView: mode });
  if (!processManager.isRunning(chatId, topicId)) return;
  await postToTopic(processManager, chatId, topicId, "/live-mode", { mode }, { timeoutMs: 5000 }).catch(() => {});
}

/**
 * Send the project's uncommitted-changes report into its topic: an HTML
 * summary, plus the full patch as a document when there is one. Shared by the
 * /diff command and the turn-end review prompt's "Show diff" button.
 */
export async function sendDiffReport(
  bot: Bot,
  chatId: number,
  topicId: number,
  projectName: string,
  projectPath: string,
): Promise<void> {
  const result = await collectGitDiff(projectPath);
  if (!result.isRepo) {
    await bot.api.sendMessage(chatId, "Not a git repository.", { message_thread_id: topicId });
    return;
  }
  if (!result.hasChanges) {
    await bot.api.sendMessage(chatId, "✅ Working tree clean — nothing uncommitted.", { message_thread_id: topicId });
    return;
  }
  const html = renderDiffHtml(result.patch, { projectName, stat: result.stat });
  await bot.api.sendMessage(chatId, formatDiffHeader(result), {
    parse_mode: "HTML",
    message_thread_id: topicId,
    reply_markup: html
      ? { inline_keyboard: [[{ text: "🖼 Preview as images", callback_data: DIFF_IMAGE_CALLBACK_DATA }]] }
      : undefined,
  });

  if (result.patch) {
    await bot.api.sendDocument(
      chatId,
      new InputFile(Buffer.from(result.patch, "utf8"), `${projectName}-uncommitted.patch`),
      { message_thread_id: topicId, disable_notification: true },
    );
  }

  if (html) {
    await bot.api.sendDocument(
      chatId,
      new InputFile(Buffer.from(html, "utf8"), `${projectName}-diff.html`),
      { message_thread_id: topicId, disable_notification: true },
    );
  } else if (result.patch) {
    await bot.api.sendMessage(
      chatId,
      "Diff too large for an HTML preview — see the attached .patch.",
      { message_thread_id: topicId, disable_notification: true },
    ).catch(() => {});
  }
}

/** Per-topic guard: a second "Preview as images" tap while one is already
 *  rendering answers instead of starting a redundant, competing render. */
const diffImageInFlight = new Set<string>();

/**
 * Handle the "🖼 Preview as images" button: re-collect the diff (state-free —
 * if it changed since /diff was sent, that's fine and honest), render it to
 * paged PNGs, and send them as one media-group album. Never throws — every
 * failure path reports a plain-text message to the topic instead.
 */
export async function sendDiffImagePreview(
  bot: Bot,
  chatId: number,
  topicId: number,
  projectName: string,
  projectPath: string,
): Promise<void> {
  const key = topicKey(chatId, topicId);
  if (diffImageInFlight.has(key)) {
    await bot.api.sendMessage(chatId, "Already rendering a preview for this topic — hang tight.", {
      message_thread_id: topicId,
    }).catch(() => {});
    return;
  }
  diffImageInFlight.add(key);

  const tempFiles: string[] = [];
  try {
    const result = await collectGitDiff(projectPath);
    if (!result.isRepo || !result.hasChanges || !result.patch) {
      await bot.api.sendMessage(chatId, "Nothing to preview — the working tree has no diff right now.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return;
    }

    const html = renderDiffHtml(result.patch, { projectName, stat: result.stat });
    if (!html) {
      await bot.api.sendMessage(chatId, "Diff too large to render as images — see the .patch/.html from /diff.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return;
    }

    const paths = await renderHtmlToImages(html);
    tempFiles.push(...paths);
    if (paths.length === 0) {
      await bot.api.sendMessage(chatId, "Nothing rendered — the diff produced no visible pages.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return;
    }

    const truncated = paths.length >= 10;
    const media = paths.slice(0, 10).map((p, i) => ({
      type: "photo" as const,
      media: new InputFile(p),
      caption: i === 0
        ? `${projectName} — diff preview (page 1/${paths.length}${truncated ? ", truncated — full diff in the HTML/patch" : ""})`
        : undefined,
    }));
    await bot.api.sendMediaGroup(chatId, media, { message_thread_id: topicId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[diffimg] render failed: ${msg}`);
    await bot.api.sendMessage(chatId, `Preview failed: ${msg}`, { message_thread_id: topicId }).catch(() => {});
  } finally {
    diffImageInFlight.delete(key);
    for (const p of tempFiles) {
      try { unlinkSync(p); } catch { /* ignore — best-effort cleanup */ }
    }
  }
}

const startTime = Date.now();

// --- /help pages ---
// Split per scope so a project topic isn't shown group-only commands (and vice
// versa), and so the scheduling syntax can live on its own page instead of
// bloating the main listing.

export function generalHelp(): string[] {
  return [
    "<b>Teleclaude</b> — Claude Code in Telegram. One topic = one project = one persistent session.",
    "",
    "<b>General topic / DM</b>",
    "/new &lt;name&gt; &lt;path&gt; — Create a project + forum topic (<code>~</code> expands)",
    "/list — This group's projects (🟢 = session running)",
    "/ls [path] — Browse the filesystem, create a project from a folder",
    "/delete &lt;name&gt; — Delete a project and its topic",
    "/status — Version, uptime, memory, running sessions",
    "/usage — Weekly token usage + quota across all projects",
    "/update — Pull the latest version and restart (confirm button)",
    "/restart — Restart the bot service (confirm button)",
    "/help [schedule] — This help; <code>/help schedule</code> for the scheduling reference",
  ];
}

export function projectHelp(): string[] {
  return [
    "<b>Project topic</b>",
    "/new [name] — Fresh session (keeps model, effort, permissions)",
    "/stop — Kill this topic's session",
    "/cancel — Cancel the in-flight turn (keeps the session alive)",
    "/rename [name] — Name this session (no name = Claude picks one from the conversation)",
    "/model [id|alias] — Switch model via buttons (persisted)",
    "/effort [level|auto] — Switch reasoning effort via buttons (persisted)",
    "/permissions — Auto / Supervised / Bypass (persisted)",
    "/live [full|summary|off] — Live turn view detail (persisted, no restart)",
    "/notify — Toggle 💬 push notification when a turn finishes",
    "/webhook [new|off] — Inbound webhook for this project (<code>new</code> creates/rotates, <code>off</code> disables)",
    "/review — Toggle a turn-end prompt when the tree has uncommitted changes",
    "/receipts — Toggle a one-line ⏱/🔧/tokens receipt after each turn",
    "/pin — Toggle the pinned session-name message (default on)",
    "/status — Session status, model, permissions",
    "/usage — Tokens, context window %, session totals",
    "/sessions — Recent sessions with resume buttons (🔺 = open in another Claude process)",
    "/resume &lt;id&gt; — Resume a specific session",
    "/handoff — Hand this session to your terminal (stops it here, gives you the <code>claude --resume</code> command)",
    "/screenshot &lt;url&gt; — Screenshot a URL",
    "/diff — Uncommitted git changes (summary + patch file)",
    "",
    "<b>Scheduling</b> (host local time — <code>/help schedule</code> for details)",
    "/at &lt;when&gt; [project] &lt;message&gt; — One-off run",
    "/every &lt;spec&gt; [project] &lt;message&gt; — Recurring run",
    "/digest [HH:MM] — Recurring briefing presets (morning / end-of-day / weekly)",
    "/schedules — List with ❌ cancel buttons · /unschedule &lt;id&gt;",
  ];
}

export function extrasHelp(): string[] {
  return [
    "<b>Beyond commands</b>",
    "• Just type in a project topic — it goes straight to that session.",
    "• <code>/&lt;project&gt; &lt;message&gt;</code> from a DM or General routes into that project's topic.",
    "• Send a photo, voice note or document in a topic — saved to <code>_inbox/</code> and handed to Claude (voice is transcribed).",
    "• Default is ⚡ auto: a classifier vets each action. Anything it blocks, or repeated blocks, fall back to Allow/Deny buttons here.",
    "• A stalled turn pings you with a 🛑 Force stop session button; quota exhaustion DMs you and again when it resets.",
  ];
}

export function scheduleHelp(): string[] {
  return [
    "<b>Scheduling</b> — wake a session on a timer.",
    "A scheduled run takes the same path as a message you type: it spawns or resumes the session, waits for the channel, and reports stalls.",
    "",
    "<b>One-off</b> — /at &lt;when&gt; [project] &lt;message&gt;",
    "<code>07:00</code> — next 07:00 (tomorrow if today's has passed)",
    "<code>tomorrow 06:15</code>",
    "<code>2026-08-02 09:00</code>",
    "<code>+30m</code> · <code>+2h</code> · <code>+1d</code>",
    "",
    "<b>Recurring</b> — /every &lt;spec&gt; [project] &lt;message&gt;",
    "<code>day 07:00</code> — every day",
    "<code>mon-fri 09:30</code> · <code>mon,wed 18:00</code> · <code>weekday</code> · <code>weekend</code>",
    "<code>30m</code> · <code>2h</code> — fixed interval",
    '<code>"0 7 * * 1-5"</code> — raw 5-field cron (quoted)',
    "",
    "<b>Flags</b> (right after the project name)",
    "<code>--new</code> — fresh session first (drops only the session id)",
    "<code>--model opus</code> — switch model first (persists, like /model)",
    "<code>--effort high</code> — switch effort first (persists)",
    "",
    "<b>Where</b>",
    "In a project topic the project is implied: <code>/at 07:00 run the tests</code>",
    "In General or a DM, name it: <code>/at 07:00 recipes log yesterday's meals</code>",
    "",
    "<b>Managing</b>",
    "/schedules — this topic's, the group's, or (in a DM) the ones you created — with ❌ buttons",
    "/unschedule &lt;id&gt; — id or an unambiguous prefix",
    "",
    "<i>Times are the host's local time. Jobs survive restarts; a run missed while the bot was down still fires if it's under 30 minutes late, otherwise it's skipped with a note.</i>",
  ];
}

export function registerCommands(bot: Bot, processManager: ProcessManager, configDir?: string): void {
  // --- General topic commands ---

  bot.command("help", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const inTopic = !isGeneralTopic(topicId) && topicId !== undefined;
    const replyOpts = inTopic ? { message_thread_id: topicId } : {};
    const page = (ctx.match ?? "").toString().trim().toLowerCase();

    // /help schedule — the one area with enough syntax to deserve its own page.
    if (page && ("scheduling".startsWith(page) || page === "cron" || page === "at" || page === "every")) {
      await ctx.reply(scheduleHelp().join("\n"), { parse_mode: "HTML", ...replyOpts });
      return;
    }

    const lines = inTopic
      ? [...projectHelp(), "", ...extrasHelp(), "", "General-topic commands: run /help in the group's General topic."]
      : [...generalHelp(), "", ...projectHelp(), "", ...extrasHelp()];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", ...replyOpts });
  });

  bot.command("new", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const chatId = ctx.chat.id;

    // In a project topic: restart Claude Code (fresh session)
    if (!isGeneralTopic(topicId) && topicId) {
      const project = getProject(chatId, topicId, configDir);
      if (!project) {
        await ctx.reply("This topic is not linked to a project.");
        return;
      }
      // `/new <name>` starts the fresh session under that name (claude -n).
      // A bare `/new` deliberately CLEARS any previous name rather than carrying
      // it over: the old name described the conversation that just ended.
      const rawName = commandArgument(ctx.message!.text ?? "");
      const name = sanitizeSessionName(rawName);
      if (rawName && !name) {
        await ctx.reply("That name is empty once control characters are stripped. Usage: /new [name]", { message_thread_id: topicId });
        return;
      }
      log(`[cmd:new] topic=${topicId} project=${project.name} name=${name ?? "(claude-derived)"} — restarting session`);
      // Drop only the session id — keep model/permissions/effort so
      // persisted settings and DM routing survive a fresh session. A fresh
      // session always starts at the project root — clear any cwd a previous
      // resume into a worktree/subfolder had persisted.
      updateTopicSession(chatId, topicId, { sessionId: "", projectPath: project.path, name, sessionCwd: undefined });
      processManager.restart(chatId, topicId, project.path, spawnSettingsFor(getTopicSession(chatId, topicId)));
      // "started", not "restarted": /new always begins a fresh session (the old
      // session id is dropped), so from the user's side nothing is resuming —
      // whether or not a process happened to be running here a moment ago.
      await ctx.reply(
        name ? `Session started as <b>${escapeHtml(name)}</b>.` : "Session started.",
        { parse_mode: "HTML", message_thread_id: topicId },
      );
      return;
    }

    // In General topic: create a new project
    if (!isGeneralTopic(topicId)) return;

    const parsed = parseNewCommand(ctx.message!.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /new <name> <path>");
      return;
    }

    const { name, path: projectPath } = parsed;

    if (getProjectByName(chatId, name, configDir)) {
      await ctx.reply(`Project "${name}" already exists.`);
      return;
    }

    // Two names that fold to the same /command are indistinguishable to routing
    // and can't both appear in Telegram's menu.
    const clash = findRouteCollision(name, configDir);
    if (clash) {
      await ctx.reply(`"${name}" collides with existing project "${clash.name}" — both become the same /command. Pick another name.`);
      return;
    }

    if (!existsSync(projectPath)) {
      pendingProjects.set(ctx.chat.id, { name, path: projectPath });
      await ctx.reply(
        `Directory <code>${escapeHtml(projectPath)}</code> does not exist. Create it?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "Yes, create it", callback_data: "mkdir:yes" },
              { text: "No", callback_data: "mkdir:no" },
            ]],
          },
        },
      );
      return;
    }

    preTrustWorkspace(projectPath);
    const topicResult = await bot.api.createForumTopic(ctx.chat.id, name);
    addProject({
      name,
      path: projectPath,
      chatId,
      topicId: topicResult.message_thread_id,
      createdAt: new Date().toISOString(),
    }, configDir);

    await ctx.reply(`Project "${name}" created in topic #${topicResult.message_thread_id}.`);
  });

  bot.command("list", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const projects = getProjectsForChat(chatId, configDir);
    if (projects.length === 0) {
      await ctx.reply("No projects registered. Use /new to create one.");
      return;
    }

    const lines = projects.map((p) => {
      const running = processManager.isRunning(chatId, p.topicId) ? " 🟢" : "";
      return `• <b>${escapeHtml(p.name)}</b> — <code>${escapeHtml(p.path)}</code>${running}`;
    });

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("delete", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const parsed = parseDeleteCommand(ctx.message!.text ?? "");
    if (!parsed) {
      await ctx.reply("Usage: /delete <name>");
      return;
    }

    const project = getProjectByName(chatId, parsed.name, configDir);
    if (!project) {
      await ctx.reply(`Project "${parsed.name}" not found.`);
      return;
    }

    const projectChatId = project.chatId ?? chatId;

    // Kill Claude Code if running, then drop the topic's runtime entirely —
    // kill() only dispose()s (topic memory like the blocked-channel cooldown
    // must survive a kill); deleting the project is the one moment nothing
    // should survive.
    processManager.kill(projectChatId, project.topicId);
    removeTopicRuntime(projectChatId, project.topicId);
    // Drop any inbound webhook token for the deleted topic (its POSTs would 410
    // on the missing project anyway — this just doesn't leave a stale entry).
    removeWebhook(projectChatId, project.topicId, configDir);

    // Close the forum topic
    try {
      await bot.api.closeForumTopic(projectChatId, project.topicId);
      await bot.api.deleteForumTopic(projectChatId, project.topicId);
    } catch { /* topic might already be deleted */ }

    removeProject(projectChatId, parsed.name, configDir);
    await ctx.reply(`Project "${parsed.name}" deleted.`);
  });

  // Single registration for both scopes — a second bot.command("status") would
  // never run: the first matching handler consumes the update in grammy.
  bot.command("status", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const chatId = ctx.chat.id;

    // In a project topic: session status
    if (!isGeneralTopic(topicId) && topicId) {
      const project = getProject(chatId, topicId, configDir);
      if (!project) return;

      const running = processManager.isRunning(chatId, topicId);
      const model = processManager.getModel(chatId, topicId);
      const sessionId = processManager.getSessionId(chatId, topicId);
      const saved = getTopicSession(chatId, topicId);

      const permMode = effectivePermissionMode(processManager, chatId, topicId);
      const doneNotify = processManager.isDoneNotify(chatId, topicId);
      // Claude Code's live-session registry is authoritative while the session
      // runs — it reflects a /rename typed at the terminal, and the name Claude
      // Code derived for a session nobody ever named. Fall back to what we
      // persisted, which is what the next spawn would apply.
      const pid = processManager.getPid(chatId, topicId);
      const liveName = pid ? readLiveSessionName(pid) : undefined;
      const sessionName = liveName ?? processManager.getSessionName(chatId, topicId) ?? saved?.name;
      const lines = [
        `<b>Session info</b>`,
        `Status: ${running ? "🟢 Running" : "🔴 Stopped"}`,
        `Model: <code>${model}</code>`,
        `Permissions: ${permissionModeShort(permMode)}`,
        `Effort: <code>${processManager.getEffort(chatId, topicId) ?? saved?.effort ?? "auto"}</code>`,
        `Notifications: ${doneNotify ? "🔔 On" : "🔕 Off"}`,
      ];

      if (sessionName) {
        lines.push(`Name: <code>${escapeHtml(sessionName)}</code>`);
      }

      if (sessionId || saved?.sessionId) {
        const id = sessionId ?? saved?.sessionId ?? "";
        lines.push(`Session: <code>${id.slice(0, 8)}</code>`);
      }

      lines.push(`Project: <code>${escapeHtml(project.path)}</code>`);

      if (running) {
        lines.push("", "Send /new for fresh session, /model to switch model.");
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "HTML", message_thread_id: topicId });
      return;
    }
    if (!isGeneralTopic(topicId)) return;

    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1024 / 1024).toFixed(1);

    // Scope to this group — each group manages its own projects/sessions.
    const processes = processManager.status().filter((p) => p.chatId === chatId);
    const runningCount = processes.filter((p) => p.running).length;

    const lines = [
      `<b>Teleclaude</b> <code>${escapeHtml(versionString())}</code>`,
      `Uptime: ${h}h ${m}m`,
      `Memory: ${rss}MB`,
      `Projects: ${getProjectsForChat(chatId, configDir).length}`,
      `Running sessions: ${runningCount}`,
    ];

    if (processes.length > 0) {
      lines.push("");
      for (const p of processes) {
        const status = p.running ? "🟢" : "🔴";
        lines.push(`${status} Topic ${p.topicId} — port ${p.port}`);
      }
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // Single registration for both scopes (same reason as /status above).
  bot.command("usage", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    const chatId = ctx.chat.id;

    // In a project topic: session usage + context window
    if (!isGeneralTopic(topicId) && topicId) {
      const project = getProject(chatId, topicId, configDir);
      if (!project) return;

      const sessionId = processManager.getSessionId(chatId, topicId) ?? getTopicSession(chatId, topicId)?.sessionId;
      if (!sessionId) {
        await ctx.reply("No active session.", { message_thread_id: topicId });
        return;
      }

      // A worktree/subfolder-homed session's transcript doesn't live under the
      // project root — resolve where it actually is (see sessions.ts's
      // sessionHomes) rather than reporting "no usage data" for a session that
      // has plenty, just in the wrong directory.
      const usageCwd = resolveSessionHome(project.path, sessionId)?.cwd ?? project.path;
      const [usage, quota] = await Promise.all([
        Promise.resolve(getSessionUsage(sessionId, usageCwd)),
        getQuota(),
      ]);
      if (!usage) {
        await ctx.reply("No usage data available yet.", { message_thread_id: topicId });
        return;
      }

      const fmt = (n: number) => n.toLocaleString("en-US");
      const bar = (pct: number) => {
        const filled = Math.round(pct / 10);
        return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${pct}%`;
      };

      const lines: string[] = [];
      if (quota) {
        lines.push(...formatQuotaLines(quota), "");
      } else {
        lines.push("<i>Quota unavailable — couldn't reach the quota API.</i>", "");
      }
      lines.push(
        `<b>Usage — ${usage.model || "unknown model"}</b>`,
        "",
        `Context window`,
        `<code>${bar(usage.contextPercent)}</code>`,
        `${fmt(usage.contextTokens)} / ${fmt(usage.contextWindow)} tokens`,
        "",
        `<b>Session totals</b>`,
        `Turns: ${fmt(usage.messageCount)}`,
        `Output: ${fmt(usage.totalOutputTokens)} tokens`,
        `Input (all turns): ${fmt(usage.totalInputTokens)} tokens`,
      );

      if (usage.costUSD !== null) {
        lines.push(`Cost: $${usage.costUSD.toFixed(4)}`);
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "HTML", message_thread_id: topicId });
      return;
    }
    if (!isGeneralTopic(topicId)) return;

    const [usage, quota] = await Promise.all([
      Promise.resolve(getWeeklyUsage(7)),
      getQuota(),
    ]);
    const fmt = (n: number) => n.toLocaleString("en-US");

    const lines: string[] = [];
    if (quota) {
      lines.push(...formatQuotaLines(quota), "");
    } else {
      lines.push("<i>Quota unavailable — couldn't reach the quota API.</i>", "");
    }

    const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    lines.push(
      `<b>Usage — last 7 days</b>`,
      "",
      `Turns: ${fmt(usage.turns)}`,
      `Output tokens: ${fmt(usage.outputTokens)}`,
      `Input tokens: ${fmt(totalInput)}`,
      `  • New: ${fmt(usage.inputTokens)}`,
      `  • Cache read: ${fmt(usage.cacheReadTokens)}`,
      `  • Cache write: ${fmt(usage.cacheCreationTokens)}`,
    );

    if (usage.costUSD !== null) {
      lines.push("", `Cost: $${usage.costUSD.toFixed(4)}`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // Chat-safe self-update: checks are done here while the daemon is healthy;
  // the actual pull/install/restart runs from the confirm button (index.ts),
  // and the restart itself is spawned detached so it survives the daemon it
  // kills. A marker file lets the fresh daemon confirm back into this chat.
  bot.command("update", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!isGeneralTopic(topicId)) return;

    const check = await checkForUpdate();
    if (!check.ok) {
      await ctx.reply(`⚠️ Can't update: ${check.reason}`);
      return;
    }
    if (check.behind === 0) {
      await ctx.reply(`Already up to date — ${versionString()}`);
      return;
    }
    const running = processManager.status().filter((p) => p.running).length;
    const warning = running > 0
      ? `\n\n⚠️ ${running} running session(s) will be interrupted mid-turn (they resume with context).`
      : "";
    await ctx.reply(
      `Update available: ${check.behind} commit(s) behind origin (current ${versionString()}).${warning}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "🚀 Update & restart", callback_data: "selfupdate:go" },
            { text: "Cancel", callback_data: "selfupdate:no" },
          ]],
        },
      },
    );
  });

  bot.command("restart", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!isGeneralTopic(topicId)) return;

    const running = processManager.status().filter((p) => p.running).length;
    const warning = running > 0
      ? `\n\n⚠️ ${running} running session(s) will be interrupted mid-turn (they resume with context).`
      : "";
    await ctx.reply(`Restart the bot service? (${versionString()})${warning}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "♻️ Restart", callback_data: "selfrestart:go" },
          { text: "Cancel", callback_data: "selfrestart:no" },
        ]],
      },
    });
  });

  bot.command("ls", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!isGeneralTopic(topicId)) return;

    const arg = ctx.message!.text?.split(/\s+/).slice(1).join(" ").trim() ?? "";
    const startPath = arg
      ? arg.replace(/^~/, homedir())
      : homedir();

    try {
      await sendLsListing(bot, ctx.chat.id, startPath, ctx.message!.message_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed to list directory: ${msg}`);
    }
  });

  // --- Project topic commands ---

  bot.command("sessions", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    try {
      const sessions = await listProjectSessions(project.path);
      if (sessions.length === 0) {
        await ctx.reply("No sessions found.", { message_thread_id: topicId });
        return;
      }

      const currentId = processManager.getSessionId(chatId, topicId);
      const ownPid = processManager.getPid(chatId, topicId);
      // A name set with `claude -n` (a named /new) writes nothing to the
      // transcript, so listProjectSessions can't see it — but this topic's
      // persisted name applies to exactly this session id. Prefer it.
      const savedForList = getTopicSession(chatId, topicId);
      const named = (s: { sessionId: string; summary: string }): string =>
        savedForList?.name && s.sessionId === (currentId ?? savedForList.sessionId)
          ? savedForList.name
          : s.summary;
      // Cheap: at most `limit` (10) sessions are ever listed, so a full
      // registry scan per row (live-sessions.ts) is fine — no cache needed.
      const isElsewhere = (s: { sessionId: string }): boolean => isSessionLiveElsewhere(s.sessionId, ownPid);
      const lines = sessions.map((s, i) => {
        const date = new Date(s.lastModified).toLocaleDateString();
        const active = currentId === s.sessionId ? " 🟢" : "";
        const elsewhere = isElsewhere(s) ? " 🔺" : "";
        const subpath = s.subpath ? ` ↳ <i>${escapeHtml(s.subpath)}</i>` : "";
        return `${i + 1}. <code>${s.sessionId.slice(0, 8)}</code> — ${escapeHtml(named(s))}${active}${elsewhere} (${date})${subpath}`;
      });
      const footer = sessions.some(isElsewhere)
        ? "\n\n🔺 open in another Claude process right now — resuming here will be refused."
        : "";

      const buttons = sessions.map((s) => {
        const d = new Date(s.lastModified);
        const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
        const summary = named(s);
        // Keep the tail of a long subpath (the distinctive part of a worktree
        // path), and bound the label: Telegram clients ellipsize long button
        // text, but an unbounded label risks hitting API-side limits.
        const sub = s.subpath && s.subpath.length > 18 ? `…${s.subpath.slice(-17)}` : s.subpath;
        const subpath = sub ? ` ↳ ${sub}` : "";
        const label = `${date}. ${summary.slice(0, 30)}${summary.length > 30 ? "..." : ""}${subpath}`;
        return [{ text: label, callback_data: `resume:${s.sessionId}` }];
      });

      await ctx.reply(lines.join("\n") + footer, {
        parse_mode: "HTML",
        message_thread_id: topicId,
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err) {
      await ctx.reply("Failed to list sessions.", { message_thread_id: topicId });
    }
  });

  bot.command("resume", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const sessionId = ctx.message!.text?.split(/\s+/)[1];
    if (!sessionId) {
      await ctx.reply("Usage: /resume <session-id>", { message_thread_id: topicId });
      return;
    }

    log(`[cmd:resume] topic=${topicId} session=${sessionId.slice(0, 8)} project=${project.name}`);
    const result = await resumeSession(processManager, chatId, topicId, project.path, sessionId);
    if (!result.ok) {
      const text = result.reason === "not-found"
        ? `Session <code>${sessionId.slice(0, 8)}</code> not found. Use /sessions to list.`
        : result.reason === "live-elsewhere"
        ? `🔺 That session is open in another Claude process (pid ${result.pid}) — resuming here would risk two processes writing the same transcript. Close it there first, or use /handoff to move it deliberately.`
        : `Can't resume — ${escapeHtml(result.message)}`;
      await ctx.reply(text, { parse_mode: "HTML", message_thread_id: topicId });
      return;
    }
    await ctx.reply(
      `Resuming session ${sessionId.slice(0, 8)}${result.subpath ? ` (↳ ${escapeHtml(result.subpath)})` : ""}...`,
      { parse_mode: "HTML", message_thread_id: topicId },
    );
  });

  bot.command("handoff", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const saved = getTopicSession(chatId, topicId);
    // getSessionId first: it's the running process's own id, more current than
    // whatever was last persisted. Read BEFORE kill() below — kill() deletes
    // the in-memory entry synchronously.
    const sessionId = processManager.getSessionId(chatId, topicId) || saved?.sessionId;
    if (!sessionId) {
      await ctx.reply("No session to hand off yet — send a message here first so one exists.", { message_thread_id: topicId });
      return;
    }

    const wasRunning = processManager.isRunning(chatId, topicId);
    if (wasRunning) {
      log(`[cmd:handoff] topic=${topicId} session=${sessionId.slice(0, 8)} — stopping so the terminal can take over`);
      processManager.kill(chatId, topicId);
    }

    // A worktree-homed session hands off at its own cwd (persisted as
    // sessionCwd when it was resumed), not the project root — the terminal
    // resume must run where the transcript actually lives.
    const cwd = saved?.sessionCwd || project.path;
    await ctx.reply(buildHandoffMessage(cwd, sessionId, wasRunning), {
      parse_mode: "HTML",
      message_thread_id: topicId,
    });
  });

  bot.command("stop", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    if (!processManager.isRunning(chatId, topicId)) {
      log(`[cmd:stop] topic=${topicId} no active session`);
      await ctx.reply("No active session.", { message_thread_id: topicId });
      return;
    }

    log(`[cmd:stop] topic=${topicId} project=${project.name} — killing`);
    processManager.kill(chatId, topicId);
    await ctx.reply("Session stopped.", { message_thread_id: topicId });
  });

  bot.command("cancel", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    log(`[cmd:cancel] topic=${topicId} project=${project.name}`);
    const result = await requestCancel(bot, processManager, chatId, topicId);
    if (result === "not-running") {
      await ctx.reply("No active session.", { message_thread_id: topicId });
    }
    // "sent" already notified the user from within requestCancel.
  });

  bot.command("rename", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const raw = commandArgument(ctx.message!.text ?? "");
    const requested = sanitizeSessionName(raw);
    // A bare /rename means "name it from the conversation" (Claude Code's own
    // behaviour). Text that survives nothing but control characters is a typo,
    // not a request to auto-generate — so it gets an error instead.
    if (raw && !requested) {
      await ctx.reply("That name is empty once control characters are stripped. Usage: /rename <name>", { message_thread_id: topicId });
      return;
    }

    log(`[cmd:rename] topic=${topicId} project=${project.name} name=${requested ?? "(auto)"}`);
    const result = await requestRename(processManager, chatId, topicId, requested);

    // Persist whatever the session actually ended up called, so the next spawn
    // re-applies it with `claude -n`. On an unconfirmed rename the request is
    // still the best guess available; on a bare /rename with nothing read back
    // there is nothing to store.
    const persist = result.name ?? requested;
    if (persist) updateTopicSession(chatId, topicId, { name: persist, projectPath: project.path });

    await ctx.reply(renameNotice(result, requested), { parse_mode: "HTML", message_thread_id: topicId });

    // A rename is the one moment the name definitely changed — refresh the
    // pinned session-name message now instead of waiting for the next turn.
    await maintainSessionPin(ctx.api, chatId, topicId, {
      pid: processManager.getPid(chatId, topicId),
    }).catch(() => {});
  });

  bot.command("screenshot", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;

    const url = ctx.message!.text?.split(/\s+/).slice(1).join(" ");
    if (!url) {
      await ctx.reply("Usage: /screenshot <url>\nExample: /screenshot http://localhost:3000", {
        message_thread_id: topicId,
      });
      return;
    }

    await ctx.reply("📸 Capturing...", { message_thread_id: topicId, disable_notification: true });

    try {
      const filePath = await takeScreenshot({ url });
      await bot.api.sendPhoto(ctx.chat.id, new InputFile(filePath), {
        message_thread_id: topicId,
      });
      // Clean up temp file
      try { (await import("fs")).unlinkSync(filePath); } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Screenshot failed: ${msg}`, { message_thread_id: topicId });
    }
  });

  bot.command("diff", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;
    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    log(`[cmd:diff] topic=${topicId} project=${project.name}`);
    try {
      await sendDiffReport(bot, chatId, topicId, project.name, diffCwdFor(chatId, topicId, project.path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Diff failed: ${msg}`, { message_thread_id: topicId }).catch(() => {});
    }
  });

  bot.command("permissions", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const arg = ctx.match?.toString().trim();
    const current = effectivePermissionMode(processManager, chatId, topicId);

    if (arg) {
      const parsed = parsePermissionMode(arg);
      if (!parsed) {
        await ctx.reply(`Unknown mode <code>${escapeHtml(arg)}</code>. Send /permissions to pick from buttons.`, {
          message_thread_id: topicId, parse_mode: "HTML",
        });
        return;
      }
      switchPermissionMode(processManager, chatId, topicId, project.path, parsed);
      await ctx.reply(
        `Permissions: <b>${permissionModeLabel(parsed)}</b>\n${permissionModeHelp(parsed)}\n\nSession restarting…`,
        { message_thread_id: topicId, parse_mode: "HTML" },
      );
      return;
    }

    await ctx.reply(
      `Permissions: <b>${permissionModeLabel(current)}</b>\n\nPick a mode — the session restarts with it.`,
      {
        message_thread_id: topicId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: PERMISSION_MODES.map((m) => [{
            text: `${m === current ? "✓ " : ""}${permissionModeShort(m)}`,
            callback_data: `permmode:${m}`,
          }]),
        },
      },
    );
  });

  bot.command("live", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const arg = ctx.match?.toString().trim();
    const current = getTopicSession(chatId, topicId)?.liveView ?? "summary";

    if (arg) {
      const parsed = parseLiveViewMode(arg);
      if (!parsed) {
        await ctx.reply(`Unknown mode <code>${escapeHtml(arg)}</code>. Send /live to pick from buttons.`, {
          message_thread_id: topicId, parse_mode: "HTML",
        });
        return;
      }
      await switchLiveView(processManager, chatId, topicId, parsed);
      await ctx.reply(`Live view: <b>${liveViewLabel(parsed)}</b>`, { message_thread_id: topicId, parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      `Live view: <b>${liveViewLabel(current)}</b>\n\nPick a mode.`,
      {
        message_thread_id: topicId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: LIVE_VIEW_MODES.map((m) => [{
            text: `${m === current ? "✓ " : ""}${liveViewLabel(m)}`,
            callback_data: `live:${m}`,
          }]),
        },
      },
    );
  });

  // Removed in favour of /permissions. Kept only as a pointer: Telegram clients
  // cache the command menu, so a stale /bypass entry stays tappable for a while,
  // and without a handler the text would be forwarded to Claude as a prompt.
  bot.command("bypass", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId) return;
    await ctx.reply("/bypass is now /permissions — pick Auto, Supervised or Bypass there.", {
      message_thread_id: isGeneralTopic(topicId) ? undefined : topicId,
    });
  });

  bot.command("notify", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const saved = getTopicSession(chatId, topicId);
    const current = saved?.doneNotify ?? false;
    const newValue = !current;

    updateTopicSession(chatId, topicId, { doneNotify: newValue });
    processManager.setDoneNotify(chatId, topicId, newValue);

    log(`[cmd:notify] topic=${topicId} doneNotify=${current} → ${newValue}`);
    await ctx.reply(newValue ? "🔔 Done notifications ON — you'll get a 💬 when Claude finishes." : "🔕 Done notifications OFF.", {
      message_thread_id: topicId,
    });
  });

  bot.command("review", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const saved = getTopicSession(chatId, topicId);
    const current = saved?.reviewOnDone ?? false;
    const newValue = !current;

    updateTopicSession(chatId, topicId, { reviewOnDone: newValue });

    log(`[cmd:review] topic=${topicId} reviewOnDone=${current} → ${newValue}`);
    await ctx.reply(
      newValue
        ? "🔍 Review-on-done ON — when a turn ends with uncommitted changes, I'll offer a diff."
        : "🔍 Review-on-done OFF.",
      { message_thread_id: topicId },
    );
  });

  bot.command("receipts", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const saved = getTopicSession(chatId, topicId);
    const current = saved?.receipts ?? false;
    const newValue = !current;

    // No ProcessManager mirror — unlike doneNotify, the done handler reads
    // persisted state directly (getTopicSession), so there's nothing else to update.
    updateTopicSession(chatId, topicId, { receipts: newValue });

    log(`[cmd:receipts] topic=${topicId} receipts=${current} → ${newValue}`);
    await ctx.reply(
      newValue
        ? "🧾 Turn receipts ON — a one-line ⏱/🔧/tokens summary after each turn."
        : "🧾 Turn receipts OFF.",
      { message_thread_id: topicId },
    );
  });

  bot.command("pin", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const saved = getTopicSession(chatId, topicId);
    // Unlike the other toggles this one defaults ON — absent means enabled.
    const current = saved?.pinSession ?? true;
    const newValue = !current;

    updateTopicSession(chatId, topicId, { pinSession: newValue });

    log(`[cmd:pin] topic=${topicId} pinSession=${current} → ${newValue}`);
    if (newValue) {
      await maintainSessionPin(ctx.api, chatId, topicId, {
        pid: processManager.getPid(chatId, topicId),
      }).catch(() => {});
      await ctx.reply("📌 Session pin ON — the current session name stays pinned to this topic.", {
        message_thread_id: topicId,
      });
    } else {
      await removeSessionPin(ctx.api, chatId, topicId).catch(() => {});
      await ctx.reply("📌 Session pin OFF.", { message_thread_id: topicId });
    }
  });

  bot.command("webhook", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;
    const arg = (commandArgument(ctx.message?.text ?? "") ?? "").trim().toLowerCase();

    if (arg === "off") {
      const removed = removeWebhook(chatId, topicId, configDir);
      log(`[cmd:webhook] topic=${topicId} disabled (was set: ${removed})`);
      await ctx.reply(removed ? "🔌 Webhook disabled — the old token no longer works." : "No webhook was set.", {
        message_thread_id: topicId,
      });
      return;
    }

    const existing = getWebhook(chatId, topicId, configDir);
    if (existing && arg !== "new") {
      // Never re-show the secret — only the URL and how to rotate.
      await ctx.reply(
        `🔗 Webhook active for this topic.\nPOST to <code>${escapeHtml(webhookUrl())}</code> with header <code>x-teleclaude-webhook-token</code>.\nToken is shown only once at creation — <code>/webhook new</code> rotates it, <code>/webhook off</code> disables it.`,
        { message_thread_id: topicId, parse_mode: "HTML" },
      );
      return;
    }

    // Create or rotate: mint a fresh token and show it exactly once.
    const project = getProject(chatId, topicId, configDir);
    const token = newWebhookToken();
    setWebhook(
      { token, chatId, topicId, project: project?.name ?? "", createdAt: Date.now(), createdBy: ctx.from?.id ?? 0 },
      configDir,
    );
    log(`[cmd:webhook] topic=${topicId} ${existing ? "rotated" : "created"} (token not logged)`);
    await ctx.reply(
      `🔗 Webhook ${existing ? "rotated" : "created"}. Save this token now — it won't be shown again:\n` +
        `<code>${escapeHtml(token)}</code>\n\n` +
        `POST your message to <code>${escapeHtml(webhookUrl())}</code>:\n` +
        `<pre>${escapeHtml(webhookCurlExample(token))}</pre>\n` +
        `The endpoint is local (127.0.0.1) — reach it from this machine or your own tunnel. <code>/webhook off</code> disables it.`,
      { message_thread_id: topicId, parse_mode: "HTML" },
    );
  });

  bot.command("model", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const arg = ctx.message!.text?.split(/\s+/)[1];
    const { models: available, fromApi } = await fetchAvailableModels();
    const current = processManager.isRunning(chatId, topicId)
      ? processManager.getModel(chatId, topicId)
      : getTopicSession(chatId, topicId)?.model ?? processManager.getModel(chatId, topicId);

    if (!arg) {
      // Curated picker (mirrors Claude Code's /model) — no typing, no typos
      const curated = curatedModels(available);
      const buttons = curated.map((c) => [{
        text: `${c.value === current ? "✓ " : ""}${c.label}`,
        callback_data: `setmodel:${c.value}`,
      }]);
      await ctx.reply(
        `Current model: <b>${escapeHtml(current)}</b>\n\nPick a model — the session restarts with it.`,
        { parse_mode: "HTML", message_thread_id: topicId, reply_markup: { inline_keyboard: buttons } },
      );
      return;
    }

    const resolved = resolveModel(arg, available, fromApi);
    if (!resolved) {
      await ctx.reply(`Unknown model <code>${escapeHtml(arg)}</code>. Send /model to pick from buttons.`, {
        parse_mode: "HTML",
        message_thread_id: topicId,
      });
      return;
    }

    await switchModel(processManager, chatId, topicId, project.path, resolved);
    await ctx.reply(`Model switched to <b>${escapeHtml(resolved)}</b>. Session restarting...`, {
      parse_mode: "HTML",
      message_thread_id: topicId,
    });
  });

  bot.command("effort", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;
    const project = getProject(chatId, topicId, configDir);
    if (!project) return;

    const arg = ctx.message!.text?.split(/\s+/)[1]?.toLowerCase();
    const { models: available } = await fetchAvailableModels();
    const currentModel = processManager.isRunning(chatId, topicId)
      ? processManager.getModel(chatId, topicId)
      : getTopicSession(chatId, topicId)?.model ?? processManager.getModel(chatId, topicId);
    const levels = supportedEffortLevels(findModelForValue(currentModel, available));
    const current = processManager.getEffort(chatId, topicId) ?? getTopicSession(chatId, topicId)?.effort;

    if (levels.length === 0) {
      await ctx.reply(`Model <b>${escapeHtml(currentModel)}</b> doesn't support effort levels.`, {
        parse_mode: "HTML", message_thread_id: topicId,
      });
      return;
    }

    if (!arg) {
      const buttons = levels.map((l) => [{
        text: `${l === current ? "✓ " : ""}${l}`,
        callback_data: `seteffort:${l}`,
      }]);
      buttons.push([{ text: `${current ? "" : "✓ "}auto (model default)`, callback_data: "seteffort:auto" }]);
      await ctx.reply(
        `Current effort: <b>${escapeHtml(current ?? "auto")}</b> (model: ${escapeHtml(currentModel)})\n\nPick an effort level — the session restarts with it.`,
        { parse_mode: "HTML", message_thread_id: topicId, reply_markup: { inline_keyboard: buttons } },
      );
      return;
    }

    if (arg !== "auto" && !levels.includes(arg)) {
      await ctx.reply(`Unknown effort <code>${escapeHtml(arg)}</code>. Levels: ${levels.join(", ")}, auto.`, {
        parse_mode: "HTML", message_thread_id: topicId,
      });
      return;
    }

    switchEffort(processManager, chatId, topicId, project.path, arg === "auto" ? undefined : arg);
    await ctx.reply(`Effort set to <b>${escapeHtml(arg)}</b>. Session restarting...`, {
      parse_mode: "HTML", message_thread_id: topicId,
    });
  });
}
