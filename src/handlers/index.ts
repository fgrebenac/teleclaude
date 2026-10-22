import { mkdirSync } from "fs";
import { basename } from "path";
import { Bot } from "grammy";
import {
  registerCommands, pendingProjects, switchModel, switchEffort, switchPermissionMode,
  switchLiveView, parseLiveViewMode, liveViewLabel, sendDiffReport, sendDiffImagePreview,
} from "./commands.js";
import { isDiffImageCallback } from "../diff-image-callback.js";
import { parseReviewAction } from "../review-prompt.js";
import { parsePermissionMode, permissionModeHelp, permissionModeLabel, permissionModeShort } from "../permission-mode.js";
import { registerMessageHandlers, sendToChannel } from "./message.js";
import { addProject, getProject } from "../config.js";
import { getTopicId } from "../bot.js";
import { getSessionMessages, resolveSessionHome } from "../sessions.js";
import { fetchAvailableModels, resolveModel, EFFORT_LEVELS } from "../models.js";
import { resumeSession } from "./resume.js";
import { escapeHtml } from "../telegram-format.js";
import { log } from "../log.js";
import { requestCancel, turnTokenMatches } from "../cancel.js";
import { clearTurnWarning } from "../turn-warnings.js";
import { preTrustWorkspace } from "../claude-trust.js";
import type { ProcessManager } from "../processes.js";
import { sendLsListing, lsLookup, lsRegister, pendingLsName, createProjectFromPath } from "./ls.js";
import { runUpdate, detachedServiceRestart, writeRestartMarker } from "../self-update.js";
import { versionString } from "../version.js";
import { registerScheduleCommands, handleScheduleCallback, handleDigestCallback } from "./schedule.js";
import { handleContinueCallback } from "./continue.js";
import { postToTopic } from "../channel-post.js";
import { diffCwdFor } from "../git-diff.js";

export function registerHandlers(bot: Bot, processManager: ProcessManager, configDir?: string): void {
  registerCommands(bot, processManager, configDir);
  registerScheduleCommands(bot, configDir);
  registerMessageHandlers(bot, processManager, configDir);

  // Callback query handler for inline keyboard buttons
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const topicId = ctx.callbackQuery.message?.message_thread_id;
    log(`[callback_query] data=${data} topic=${topicId ?? "none"} from=${ctx.from.id}`);

    const review = parseReviewAction(data);
    if (review) {
      await ctx.answerCallbackQuery();
      const msgId = ctx.callbackQuery.message?.message_id;
      if (review.verb === "leave") {
        if (msgId) {
          await bot.api.editMessageText(review.chatId, msgId, "✔️ Left uncommitted — /diff anytime.", {
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }
        return;
      }
      // diff and commit both retire the prompt's buttons first.
      if (msgId) {
        await bot.api.editMessageReplyMarkup(review.chatId, msgId, {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
      const project = getProject(review.chatId, review.topicId, configDir);
      if (!project) return;
      if (review.verb === "commit") {
        // Route a commit request into the session — Claude does the commit under
        // the topic's normal permission mode (no direct git from the daemon).
        await bot.api.sendMessage(review.chatId, "🤖 Asking Claude to commit the current changes…", {
          message_thread_id: review.topicId,
        }).catch(() => {});
        await sendToChannel(
          review.chatId, review.topicId, project.path,
          "Commit the current uncommitted changes with a clear, concise message. Do not push.",
          processManager, bot, configDir,
        );
        return;
      }
      // verb === "diff"
      await sendDiffReport(bot, review.chatId, review.topicId, project.name, diffCwdFor(review.chatId, review.topicId, project.path));
      return;
    }

    if (data === "mkdir:yes" || data === "mkdir:no") {
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!chatId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }

      const pending = pendingProjects.get(chatId);
      pendingProjects.delete(chatId);

      if (data === "mkdir:no" || !pending) {
        await ctx.answerCallbackQuery({ text: "Cancelled" });
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) {
          await bot.api.editMessageText(chatId, msgId, "Cancelled.", {
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }
        return;
      }

      try {
        mkdirSync(pending.path, { recursive: true });
        preTrustWorkspace(pending.path);
        const topicResult = await bot.api.createForumTopic(chatId, pending.name);
        addProject({
          name: pending.name,
          path: pending.path,
          chatId,
          topicId: topicResult.message_thread_id,
          createdAt: new Date().toISOString(),
        }, configDir);
        await ctx.answerCallbackQuery({ text: "Created!" });
        // Remove buttons and update message
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) {
          await bot.api.editMessageText(chatId, msgId, `✅ Project "${pending.name}" created.`, {
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.answerCallbackQuery({ text: "Failed" });
        const msgId = ctx.callbackQuery.message?.message_id;
        if (msgId) {
          await bot.api.editMessageText(chatId, msgId, `❌ Failed: ${msg}`, {
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {});
        }
      }
      return;
    }

    if (data.startsWith("selfupdate:") || data.startsWith("selfrestart:")) {
      const chatId = ctx.callbackQuery.message?.chat.id;
      const msgId = ctx.callbackQuery.message?.message_id;
      if (!chatId || !msgId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
      const edit = (text: string) =>
        bot.api.editMessageText(chatId, msgId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});

      if (data.endsWith(":no")) {
        await ctx.answerCallbackQuery({ text: "Cancelled" });
        await edit("Cancelled.");
        return;
      }

      if (data === "selfupdate:go") {
        await ctx.answerCallbackQuery({ text: "Updating…" });
        await edit("⏳ Pulling latest + installing dependencies…");
        const result = await runUpdate();
        if (!result.ok) {
          log(`[self-update] failed: ${result.error}`);
          await edit(`❌ Update failed: ${result.error}`);
          return;
        }
        writeRestartMarker({ chatId, note: "after update", at: Date.now() }, configDir);
        if (!detachedServiceRestart()) {
          await edit(`✅ Updated to ${versionString()}, but no service is installed — restart the foreground process manually.`);
          return;
        }
        await edit(`✅ Updated to ${versionString()}. Restarting — I'll confirm here when back online…`);
        return;
      }

      // selfrestart:go
      await ctx.answerCallbackQuery({ text: "Restarting…" });
      writeRestartMarker({ chatId, note: "after restart", at: Date.now() }, configDir);
      if (!detachedServiceRestart()) {
        await edit("⚠️ No service installed — restart the foreground process manually.");
        return;
      }
      await edit("♻️ Restarting — I'll confirm here when back online…");
      return;
    }

    if (data.startsWith("cont:")) {
      await handleContinueCallback(bot, ctx, data, configDir);
      return;
    }

    if (data.startsWith("sched:del:")) {
      await handleScheduleCallback(bot, ctx, data, configDir);
      return;
    }

    if (data.startsWith("digest:")) {
      await handleDigestCallback(ctx, data, configDir);
      return;
    }

    if (isDiffImageCallback(data)) {
      const chatId = ctx.callbackQuery.message?.chat.id;
      const cbTopicId = ctx.callbackQuery.message?.message_thread_id;
      if (!chatId || !cbTopicId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
      const project = getProject(chatId, cbTopicId, configDir);
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found" }); return; }
      await ctx.answerCallbackQuery({ text: "Rendering…" });
      await sendDiffImagePreview(bot, chatId, cbTopicId, project.name, diffCwdFor(chatId, cbTopicId, project.path));
      return;
    }

    if (data.startsWith("perm:")) {
      // Permission button: perm:yes:<requestId> or perm:no:<requestId>
      const parts = data.split(":");
      const verdict = parts[1]; // "yes" or "no"
      const requestId = parts[2];
      const topicId = ctx.callbackQuery.message?.message_thread_id;
      const permChatId = ctx.callbackQuery.message?.chat.id;

      if (topicId && permChatId) {
        // Send verdict to channel server as a text message
        await postToTopic(processManager, permChatId, topicId, "", { content: `${verdict} ${requestId}`, meta: {} }).catch(() => {});
      }

      const label = verdict === "yes" ? "✅ Allowed" : "❌ Denied";
      await ctx.answerCallbackQuery({ text: label });

      // Update the message to show the decision
      try {
        const msg = ctx.callbackQuery.message;
        if (msg && "text" in msg) {
          await bot.api.editMessageText(
            msg.chat.id, msg.message_id,
            msg.text + `\n\n${label}`,
            { reply_markup: { inline_keyboard: [] } },
          );
        }
      } catch { /* ignore */ }
      return;
    }

    if (data.startsWith("ask:")) {
      // ask_user button: ask:<pick|toggle|submit|custom|cancel>:<requestId>[:<idx>].
      // callback_data is already exactly the wire format channel-server.ts's
      // ASK_VERDICT_RE expects, so it's forwarded verbatim.
      const verb = data.split(":")[1];
      const askTopicId = ctx.callbackQuery.message?.message_thread_id;
      const askChatId = ctx.callbackQuery.message?.chat.id;

      let empty = false;
      let handled = false;
      if (askTopicId && askChatId) {
        try {
          // This bot's update loop is sequential (plain bot.start(), no
          // runner) — a hung local call here would stall every other
          // Telegram update behind it. The channel server may chain 1-2 of
          // its own Telegram API calls (edit + send) before answering, so
          // bound the wait rather than leaving it open-ended.
          const res = await postToTopic(processManager, askChatId, askTopicId, "", { content: data, meta: {} }, { timeoutMs: 8000 });
          if (res?.ok) {
            const parsed = await res.json().catch(() => ({}));
            // A live port doesn't mean a live request — a respawned session
            // (e.g. /new mid-question) has a fresh, empty relay that would
            // otherwise still answer 2xx to a stale tap. `handled` is the
            // relay's own report of whether it actually matched something.
            handled = parsed.handled === true;
            empty = parsed.empty === true;
          }
        } catch { /* best effort — the relay's own 5-minute timeout still resolves the question eventually */ }
      }

      // Every answerCallbackQuery gets a real AbortSignal — same
      // sequential-update-loop reasoning as the fetch above, since grammY's
      // own default API timeout (~500s) is far longer than acceptable here.
      // (grammY's answerCallbackQuery takes the signal as a second argument,
      // not inside the options object — unlike the plain fetch above.) Cast
      // through grammY's own declared param type: it ships its own
      // `abort-controller` polyfill types, structurally incompatible with
      // lib.dom's AbortSignal even though both are the same object at runtime.
      const askAbort = AbortSignal.timeout(5000) as Parameters<typeof ctx.answerCallbackQuery>[1];
      if (!handled) {
        await ctx.answerCallbackQuery({ text: "⚠️ This question may have already closed" }, askAbort).catch(() => {});
      } else if (verb === "submit" && empty) {
        await ctx.answerCallbackQuery({ text: "Pick at least one option first" }, askAbort).catch(() => {});
      } else if (verb === "toggle") {
        await ctx.answerCallbackQuery(undefined, askAbort).catch(() => {}); // silent — the checkbox redraw is the feedback
      } else if (verb === "custom") {
        await ctx.answerCallbackQuery({ text: "✏️ Type your answer next" }, askAbort).catch(() => {});
      } else if (verb === "cancel") {
        await ctx.answerCallbackQuery({ text: "❌ Cancelled" }, askAbort).catch(() => {});
      } else {
        await ctx.answerCallbackQuery({ text: "✅ Got it" }, askAbort).catch(() => {});
      }
      return;
    }

    if (data.startsWith("cancelturn:")) {
      const [, topicIdStr, seqStr, nonce] = data.split(":");
      const targetTopicId = Number(topicIdStr);
      const ctChatId = ctx.callbackQuery.message?.chat.id;
      if (!targetTopicId || !ctChatId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }

      // The button carries a short UI token minted when this alert was
      // rendered (ProcessManager.beginTurn) — reject a stale tap against an
      // alert for already-finished work instead of interrupting whatever
      // NEW, unrelated turn happens to be running now.
      const current = processManager.getCurrentTurnToken(ctChatId, targetTopicId);
      if (!current || !turnTokenMatches(current, seqStr, nonce)) {
        await ctx.answerCallbackQuery({ text: "That alert is from an earlier update" });
        return;
      }

      const result = await requestCancel(bot, processManager, ctChatId, targetTopicId);
      const label = result === "sent" ? "⏳ Interrupting…" : "No active session";
      await ctx.answerCallbackQuery({ text: label });
      if (result === "sent") {
        const msg = ctx.callbackQuery.message;
        if (msg) {
          await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        }
        clearTurnWarning(ctChatId, targetTopicId);
      }
      return;
    }

    if (data.startsWith("forcestop:")) {
      const [, fsTopicStr, fsSeqStr, fsNonce] = data.split(":");
      const targetTopicId = Number(fsTopicStr);
      const fsChatId = ctx.callbackQuery.message?.chat.id;
      if (!targetTopicId || !fsChatId) { await ctx.answerCallbackQuery({ text: "Invalid" }); return; }
      if (!processManager.isRunning(fsChatId, targetTopicId)) {
        await ctx.answerCallbackQuery({ text: "Already stopped" });
        return;
      }
      // Same stale-tap guard the Cancel-turn button has (turnTokenMatches): an
      // alert whose retire-edit failed must not be able to KILL new unrelated
      // work — worse than a stray interrupt, this one drops the whole session.
      if (!turnTokenMatches(processManager.getCurrentTurnToken(fsChatId, targetTopicId), fsSeqStr, fsNonce)) {
        await ctx.answerCallbackQuery({ text: "That alert is from an earlier update — session unchanged" });
        return;
      }
      processManager.kill(fsChatId, targetTopicId); // its killed-event dispose retires the warning
      await ctx.answerCallbackQuery({ text: "🛑 Stopped" });
      const msg = ctx.callbackQuery.message;
      if (msg) {
        await bot.api.editMessageText(msg.chat.id, msg.message_id, "🛑 Session force-stopped.", {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
      return;
    }

    if (data.startsWith("setmodel:")) {
      const model = data.slice("setmodel:".length);
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!topicId || !chatId) { await ctx.answerCallbackQuery({ text: "Invalid context" }); return; }
      const project = getProject(chatId, topicId, configDir);
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found" }); return; }

      // Stale buttons can carry retired model ids — re-validate before switching
      const { models, fromApi } = await fetchAvailableModels();
      if (!resolveModel(model, models, fromApi)) {
        await ctx.answerCallbackQuery({ text: "Model no longer available — send /model again" });
        return;
      }

      await ctx.answerCallbackQuery({ text: `Switching to ${model}...` });
      await switchModel(processManager, chatId, topicId, project.path, model);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await bot.api.editMessageText(msg.chat.id, msg.message_id,
          `Model switched to ${model}. Session restarting...`,
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
      }
      return;
    }

    if (data.startsWith("permmode:")) {
      const mode = parsePermissionMode(data.slice("permmode:".length));
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!topicId || !chatId) { await ctx.answerCallbackQuery({ text: "Invalid context" }); return; }
      const project = getProject(chatId, topicId, configDir);
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found" }); return; }
      if (!mode) { await ctx.answerCallbackQuery({ text: "Unknown mode — send /permissions again" }); return; }

      await ctx.answerCallbackQuery({ text: permissionModeShort(mode) });
      switchPermissionMode(processManager, chatId, topicId, project.path, mode);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await bot.api.editMessageText(msg.chat.id, msg.message_id,
          `Permissions: ${permissionModeLabel(mode)}\n${permissionModeHelp(mode)}\n\nSession restarting...`,
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
      }
      return;
    }

    if (data.startsWith("live:")) {
      const mode = parseLiveViewMode(data.slice("live:".length));
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!topicId || !chatId) { await ctx.answerCallbackQuery({ text: "Invalid context" }); return; }
      const project = getProject(chatId, topicId, configDir);
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found" }); return; }
      if (!mode) { await ctx.answerCallbackQuery({ text: "Unknown mode — send /live again" }); return; }

      await ctx.answerCallbackQuery({ text: liveViewLabel(mode) });
      await switchLiveView(processManager, chatId, topicId, mode);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await bot.api.editMessageText(msg.chat.id, msg.message_id,
          `Live view: ${liveViewLabel(mode)}`,
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
      }
      return;
    }

    if (data.startsWith("seteffort:")) {
      const level = data.slice("seteffort:".length);
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (!topicId || !chatId) { await ctx.answerCallbackQuery({ text: "Invalid context" }); return; }
      const project = getProject(chatId, topicId, configDir);
      if (!project) { await ctx.answerCallbackQuery({ text: "Project not found" }); return; }

      if (level !== "auto" && !EFFORT_LEVELS.includes(level)) {
        await ctx.answerCallbackQuery({ text: "Unknown effort level — send /effort again" });
        return;
      }

      await ctx.answerCallbackQuery({ text: `Effort: ${level}...` });
      switchEffort(processManager, chatId, topicId, project.path, level === "auto" ? undefined : level);

      const msg = ctx.callbackQuery.message;
      if (msg) {
        await bot.api.editMessageText(msg.chat.id, msg.message_id,
          `Effort set to ${level}. Session restarting...`,
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
      }
      return;
    }

    if (data.startsWith("resume:")) {
      const sessionId = data.slice("resume:".length);
      const topicId = ctx.callbackQuery.message?.message_thread_id;
      const resumeChatId = ctx.callbackQuery.message?.chat.id;
      if (!topicId || !resumeChatId) {
        log(`[resume] callback_query missing topicId/chatId`);
        await ctx.answerCallbackQuery({ text: "Invalid context" });
        return;
      }

      const project = getProject(resumeChatId, topicId, configDir);
      if (!project) {
        log(`[resume] topic=${topicId} project not found`);
        await ctx.answerCallbackQuery({ text: "Project not found" });
        return;
      }

      const result = await resumeSession(processManager, resumeChatId, topicId, project.path, sessionId);
      if (!result.ok) {
        const text = result.reason === "not-found"
          ? "Session not found"
          : result.reason === "live-elsewhere"
          ? `🔺 Open elsewhere (pid ${result.pid}) — refused`
          : "Can't resume — worktree is gone";
        await ctx.answerCallbackQuery({ text, show_alert: result.reason !== "not-found" });
        if (result.reason === "cwd-missing") {
          await bot.api.sendMessage(resumeChatId, `Can't resume — ${result.message}`, {
            message_thread_id: topicId,
          }).catch(() => {});
        }
        return;
      }

      await ctx.answerCallbackQuery({ text: `Resuming ${sessionId.slice(0, 8)}${result.subpath ? ` ↳ ${result.subpath}` : ""}...` });

      // Show session context — read from the session's ACTUAL home (root or a
      // worktree/subfolder), not always the project root, or a worktree-homed
      // session's preview would come back empty.
      const contextCwd = resolveSessionHome(project.path, sessionId)?.cwd ?? project.path;
      const messages = getSessionMessages(sessionId, contextCwd, 10);
      const chatId = ctx.callbackQuery.message!.chat.id;

      if (messages.length > 0) {
        const contextLines = messages.map((m) => {
          const icon = m.role === "user" ? "👤" : "🤖";
          const text = escapeHtml(m.text.slice(0, 100));
          return `${icon} ${text}${m.text.length > 100 ? "..." : ""}`;
        });

        await bot.api.sendMessage(chatId,
          `<b>Session resumed</b> (${sessionId.slice(0, 8)})\n\n${contextLines.join("\n")}`,
          { parse_mode: "HTML", message_thread_id: topicId },
        ).catch(() => {});
      } else {
        await bot.api.sendMessage(chatId,
          `Session resumed (${sessionId.slice(0, 8)})`,
          { message_thread_id: topicId },
        ).catch(() => {});
      }

      log(`[resume] topic=${topicId} session=${sessionId.slice(0, 8)}`);
      return;
    }

    if (data.startsWith("ls:")) {
      const id = data.slice("ls:".length);
      const path = lsLookup(id);
      const chatId = ctx.callbackQuery.message?.chat.id;
      const msgId = ctx.callbackQuery.message?.message_id;
      if (!path || !chatId || !msgId) {
        await ctx.answerCallbackQuery({ text: "Session expired — run /ls again" });
        return;
      }
      await ctx.answerCallbackQuery();
      await sendLsListing(bot, chatId, path, undefined, msgId);
      return;
    }

    if (data.startsWith("lsuse:")) {
      const id = data.slice("lsuse:".length);
      const path = lsLookup(id);
      const chatId = ctx.callbackQuery.message?.chat.id;
      const msgId = ctx.callbackQuery.message?.message_id;
      if (!path || !chatId || !msgId) {
        await ctx.answerCallbackQuery({ text: "Session expired — run /ls again" });
        return;
      }
      await ctx.answerCallbackQuery();
      const folderName = basename(path) || path; // "/" has no basename
      const autoId = lsRegister(path); // register for lsname callback
      await bot.api.editMessageText(chatId, msgId,
        `📂 <code>${escapeHtml(path)}</code>\n\nCreate a project here?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ ${folderName}`, callback_data: `lsname:${autoId}:auto` }],
              [{ text: "✏️ Custom name", callback_data: `lsname:${autoId}:custom` }],
              [{ text: "⬅️ Back", callback_data: `ls:${autoId}` }],
            ],
          },
        },
      ).catch(() => {});
      return;
    }

    if (data.startsWith("lsname:")) {
      const parts = data.split(":");
      const id = parts[1];
      const variant = parts[2]; // "auto" or "custom"
      const path = lsLookup(id);
      const chatId = ctx.callbackQuery.message?.chat.id;
      const msgId = ctx.callbackQuery.message?.message_id;
      if (!path || !chatId || !msgId) {
        await ctx.answerCallbackQuery({ text: "Session expired — run /ls again" });
        return;
      }

      if (variant === "custom") {
        pendingLsName.set(chatId, path);
        await ctx.answerCallbackQuery();
        await bot.api.editMessageText(chatId, msgId,
          `📂 <code>${escapeHtml(path)}</code>\n\nWhat should I call this project?`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
        return;
      }

      // auto: use folder name
      const name = basename(path) || "root";
      await ctx.answerCallbackQuery({ text: `Creating "${name}"...` });
      await createProjectFromPath(bot, chatId, msgId, name, path, configDir);
      return;
    }
  });
}
