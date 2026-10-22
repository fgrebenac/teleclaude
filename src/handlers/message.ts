import { join, basename } from "path";
import { mkdirSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { Bot } from "grammy";
import { getProject, loadProjects, backfillProjectChat, loadConfig, authorizedIds } from "../config.js";
import { isGeneralTopic, getTopicId } from "../bot.js";
import { log, logError } from "../log.js";

import { transcribeVoice } from "../transcribe.js";
import { downloadFile } from "./ui.js";
import { unlinkSync } from "fs";
import { resolveSpawnCwd, type ProcessManager } from "../processes.js";
import { getTopicSession, updateTopicSession, spawnSettingsFor } from "../session-state.js";
import { sessionTranscriptPath, getSessionUsage } from "../sessions.js";
import { parseRouteCommand, resolveRoute } from "../commands.js";
import { collectGitDiff, diffCwdFor } from "../git-diff.js";
import { shouldPromptReview, reviewCallbackData } from "../review-prompt.js";
import { formatReceipt } from "../turn-receipt.js";
import { maintainSessionPin } from "../session-pin.js";
import { isChatMember, filterByMembership } from "../membership.js";
import { typingActionFor, keepAliveActionFor } from "../typing-state.js";
import { pendingLsName, createProjectFromPath } from "./ls.js";
import { resolvePermissionMode } from "../permission-mode.js";
import { readinessDecision } from "../channel-ready.js";
import { showTurnWarning, clearTurnWarning } from "../turn-warnings.js";
import { topicRuntime, type TopicRuntime, type DeliveryEnvelope } from "../topic-runtime.js";
import { parseChannelResponseFlags } from "../channel-post.js";
import { maybeAutoName } from "../auto-name.js";

const INBOX_DIR = "_inbox";

// All per-conversation state lives on each topic's TopicRuntime (topic-runtime.js),
// keyed by the composite "chatId:topicId" registry — topic IDs are only unique
// within a chat, so two groups can share a topic id.
// Typing / stall / done-notify timers live in each topic's TopicRuntime
// TimerBag (slots: typing, typingStop, stall, softWarn, doneDebounce) —
// cleared as one by rt.dispose() when the process dies.
// We stop typing only once the FINAL update is confirmed sent:
//   - replies>0: the reply callback posts after the Telegram send completes, so by
//     `done` the last update has landed → stop after a short settle margin.
//   - replies===0: a /forward fallback send happens after `done` → wait for the
//     `forwarded` event before stopping.
// The settle margin is reset by any later activity, so multi-turn tasks (where the
// Stop hook can fire more than once) never cut the indicator off mid-work.
const TYPING_SETTLE_MS = 2500;  // after a confirmed final send
const TYPING_GRACE_MS = 8000;   // fallback when no send is confirmed (e.g. nothing to forward)
const TYPING_NUDGE_THROTTLE_MS = 1500;     // min gap between immediate re-sends on activity
const TYPING_UNBACKED_CAP_MS = 5 * 60_000; // idle cap on a run with no delivery-backed done coming
// Response timeout duration — detect silent failures (usage limit, stuck, etc.).
// Config-driven (defaults.stallAlertMinutes), clamped to a 1-min floor.

function stallTimeoutMs(configDir?: string): number {
  const min = loadConfig(configDir).defaults.stallAlertMinutes;
  return Math.max(60_000, (min || 5) * 60_000);
}

// Turn receipts (opt-in via /receipts): 3s after the doneDebounce fires (see the
// `done` branch below), formatReceipt(...) turns duration/tool-count/token-delta
// into one line. Reading the transcript for the token delta is bounded CPU work
// on the event loop (see sessions.ts) — skip it for very large sessions rather
// than stall the daemon.
const RECEIPT_MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Output tokens since the previous receipt, or undefined when unknowable — no
 * session/project, transcript missing or over the size cap, or no prior
 * baseline (the first receipt after a boot/respawn has nothing to diff
 * against). Never throws: a token read failing just costs the tokens segment,
 * never the receipt itself.
 */
function receiptOutputDelta(
  pm: ProcessManager,
  chatId: number,
  topicId: number,
  rt: TopicRuntime,
  configDir?: string,
): number | undefined {
  try {
    const project = getProject(chatId, topicId, configDir);
    const sessionId = pm.getSessionId(chatId, topicId) ?? getTopicSession(chatId, topicId)?.sessionId;
    if (!project || !sessionId) return undefined;
    if (statSync(sessionTranscriptPath(sessionId, project.path)).size > RECEIPT_MAX_TRANSCRIPT_BYTES) return undefined;
    const usage = getSessionUsage(sessionId, project.path);
    if (!usage) return undefined;
    const prev = rt.receiptTokenBaseline;
    rt.receiptTokenBaseline = usage.totalOutputTokens;
    return prev === undefined ? undefined : Math.max(0, usage.totalOutputTokens - prev);
  } catch {
    return undefined;
  }
}

// Channel-blocked handling. When the org disables channels, the MCP HTTP port
// still binds (so /ready looks healthy) but inbound messages are silently
// dropped. We detect the block from the PTY and tell the user instead of
// spinning a 5-minute stall timer per message.
const CHANNEL_CONFIRM_GRACE_MS = 1500;       // after /ready, wait this long for a late block banner
const CHANNEL_BLOCKED_COOLDOWN_MS = 120_000; // don't respawn a blocked topic for 2 min
const GLOBAL_BLOCKED_ALERT_WINDOW_MS = 30 * 60_000; // owner DM at most once per 30 min
// Per-topic time of last detected block (rt.channelBlockedAt) — gates respawn attempts.
// Module-wide dedupe for the one-time owner alert (boot probe / first detection).
let lastGlobalBlockedAlert = 0;

async function notifyChannelBlocked(bot: Bot, chatId: number, topicId: number): Promise<void> {
  await bot.api.sendMessage(
    chatId,
    "⚠️ Channels are disabled at the org level, so your message can't reach Claude. " +
      "An admin needs to enable Channels at claude.ai/admin-settings/claude-code. " +
      "I'll stay paused on this topic until then.",
    { message_thread_id: topicId },
  ).catch(() => {});
}
/**
 * The stored session could not be resumed. Say so, so the user knows the
 * reply that follows has none of the earlier context.
 *
 * Two distinct causes, told apart by whether the session had a `sessionCwd`
 * (a worktree/subfolder-homed session — see resolveSpawnCwd/sessionHomes):
 * with one, the transcript itself is very likely fine and it's the
 * worktree/directory on disk that's gone (deleted after a merge, etc), so
 * claiming Claude Code "cleaned up its history" would be false — instead say
 * the directory is gone and point at recreating it + `/resume <id>`. Without
 * one (the common case, a session homed at the project root), the actual
 * cause almost always is Claude Code's own retention sweep, so the original
 * text stands.
 */
async function notifySessionExpired(bot: Bot, chatId: number, topicId: number, hadCwd?: string): Promise<void> {
  const text = hadCwd
    ? `♻️ The previous session's worktree/directory (${hadCwd}) is gone, so I started a fresh session at the project root. ` +
      "If you want the old conversation back, recreate that directory and use /resume <id>. Delivering your message now."
    : "♻️ The previous session expired (Claude Code cleaned up its history), so I started a fresh one. Delivering your message now.";
  await bot.api.sendMessage(chatId, text, { message_thread_id: topicId }).catch(() => {});
}

// Last user message time (rt.lastUserMessageAt) — cancels stale done notifications.
// Messages delivered since the last completed turn (rt.pendingTurn) — re-delivered
// automatically after a StopFailure recovery (each envelope at most once, so a
// repeat failure can't loop). See DeliveryEnvelope in topic-runtime.ts.

function sendTypingAction(bot: Bot, rt: TopicRuntime): void {
  rt.lastTypingActionAt = Date.now();
  bot.api.sendChatAction(rt.chatId, "typing", { message_thread_id: rt.topicId }).catch(() => {});
}

function startTyping(bot: Bot, rt: TopicRuntime): void {
  if (rt.timers.has("typing")) return;
  sendTypingAction(bot, rt);
  rt.timers.setInterval("typing", () => sendTypingAction(bot, rt), 4000);
}

/** A real delivery is starting a turn — normal (uncapped) typing mode. Clears
 *  any leftover unbacked-mode idle cap, which would otherwise cut the new
 *  turn's indicator off mid-work. Exported for tests. */
export function beginTurnTyping(bot: Bot, rt: TopicRuntime): void {
  rt.typingUnbacked = false;
  rt.timers.clear("typingStop");
  startTyping(bot, rt);
}

function stopTyping(rt: TopicRuntime): void {
  rt.timers.clear("typingStop");
  rt.timers.clear("typing");
}

/** Keep the indicator alive on any activity and cancel a pending grace-period
 *  stop. Beyond (re)starting: Telegram clients clear the typing status every
 *  time a bot message arrives, so an already-running indicator gets an
 *  immediate (throttled — bypassed for a confirmed reply send) re-send
 *  instead of waiting up to 4s for the next interval tick — and an unbacked
 *  run (resurrected by activity, or continuing past the turn's done — the
 *  trailing-subagent case) is capped so it can never be pinned on forever. */
function keepTyping(bot: Bot, rt: TopicRuntime, statusJustCleared: boolean): void {
  const action = keepAliveActionFor({
    intervalRunning: rt.timers.has("typing"),
    unbacked: rt.typingUnbacked,
    msSinceLastAction: Date.now() - (rt.lastTypingActionAt ?? 0),
    statusJustCleared,
  }, { unbackedIdleCapMs: TYPING_UNBACKED_CAP_MS, nudgeThrottleMs: TYPING_NUDGE_THROTTLE_MS });
  if (action.start) {
    rt.typingUnbacked = true;
    startTyping(bot, rt);
  }
  if (action.idleCapMs !== undefined) {
    scheduleStopTyping(rt, action.idleCapMs); // slot-replace: activity pushes the cap forward
  } else {
    rt.timers.clear("typingStop");
  }
  if (action.sendNow) sendTypingAction(bot, rt);
}

/** Stop typing after `delayMs`; reset by any later activity (slot replace). */
function scheduleStopTyping(rt: TopicRuntime, delayMs: number): void {
  rt.timers.setTimeout("typingStop", () => stopTyping(rt), delayMs);
}

export function registerMessageHandlers(
  bot: Bot,
  processManager: ProcessManager,
  configDir?: string,
): void {
  processManager.setEventHandler(async ({ chatId, topicId, event, messageId, text }) => {
    const rt = topicRuntime(chatId, topicId);
    log(`[event] chat=${chatId} topic=${topicId} event=${event}${messageId ? ` msgId=${messageId}` : ""}${text ? ` text=${text.slice(0, 80)}` : ""}`);

    // Typing indicator lifecycle — see typing-state.ts. Stops only once the final
    // update is confirmed sent (reply delivered / forwarded), never mid-work.
    const typing = typingActionFor(event, rt.lastReplyMsg?.replyCount ?? 0, {
      settleMs: TYPING_SETTLE_MS,
      graceMs: TYPING_GRACE_MS,
    });
    if (typing.kind === "stop") stopTyping(rt);
    else if (typing.kind === "schedule") {
      // done/forwarded: from here on nothing guarantees another stop — any
      // activity landing inside the settle window (a trailing parallel
      // subagent's tool_use) continues WITHOUT a backing delivery and must
      // inherit the unbacked idle cap, not strip the pending stop and run
      // uncapped forever.
      rt.typingUnbacked = true;
      scheduleStopTyping(rt, typing.delayMs);
    } else if (typing.kind === "keep") {
      // A reply callback confirms a bot message just landed (which cleared
      // the client's typing status); other activity only suggests one may
      // follow, so it stays behind the nudge throttle.
      keepTyping(bot, rt, event === "reply");
    }

    // Session is gone — one dispose clears every timer this topic armed
    // (typing, typingStop, stall, softWarn, doneDebounce) plus lastReplyMsg and
    // replyCount: a killed process's turn never completes, so its reply
    // counters would otherwise survive into the respawned session — where a
    // nonzero count makes the first tool-less answer skip the /forward
    // fallback and the reply silently never reaches Telegram.
    if (event === "killed" || event === "disconnected") {
      rt.dispose(); // clears timers, process-scoped scratch AND the tracked warning
    }

    // Clear the stall/soft-warn timers on any meaningful response
    if (event === "reply" || event === "done" || event === "error") {
      rt.timers.clear("stall");
      rt.timers.clear("softWarn");
      clearTurnWarning(chatId, topicId);
    }

    // Track reply count for done logging
    if (event === "reply" && messageId) {
      const replyCount = (rt.lastReplyMsg?.replyCount ?? 0) + 1;
      rt.lastReplyMsg = { chatId, messageId, text: text ?? "", replyCount };
    }

    // Count tools for the /receipts turn receipt — reset when the next message
    // is delivered (sendToChannel), not on `done`.
    if (event === "tool_use") {
      rt.toolCount++;
    }

    // Claude finished a turn
    if (event === "done") {
      const last = rt.lastReplyMsg;
      log(`[done] topic=${topicId} replies=${last?.replyCount ?? 0}`);
      // Both the done-notify and the review prompt ride the SAME debounced slot:
      // the Stop hook fires per internal step (20+/task), and a single "doneDebounce"
      // timer fired 3s after the LAST done (re-set clears intermediates, cancelled if
      // a newer user message arrives) is the one place either should fire per turn.
      const wantNotify = processManager.isDoneNotify(chatId, topicId) && !!last && last.replyCount > 0;
      const wantReview = getTopicSession(chatId, topicId)?.reviewOnDone ?? false;
      const wantReceipt = getTopicSession(chatId, topicId)?.receipts ?? false;
      const wantPin = getTopicSession(chatId, topicId)?.pinSession ?? true;
      const wantAutoName = loadConfig(configDir).defaults?.autoNameSessions !== false;
      if (wantNotify || wantReview || wantReceipt || wantPin || wantAutoName) {
        const doneAt = Date.now();
        rt.timers.setTimeout("doneDebounce", async () => {
          if ((rt.lastUserMessageAt ?? 0) > doneAt) return; // superseded by new work
          if (wantAutoName) {
            // Before the pin refresh, so the pin shows the new name this turn.
            await maybeAutoName(processManager, chatId, topicId, rt.autoName, {
              enabled: true,
              persistedName: getTopicSession(chatId, topicId)?.name,
            });
          }
          if (wantPin) {
            // Keep the pinned session-name message current — reads the live
            // (possibly derived) name from Claude Code's registry via the pid.
            await maintainSessionPin(bot.api, chatId, topicId, {
              pid: processManager.getPid(chatId, topicId),
            }).catch(() => {});
          }
          if (wantNotify) {
            await bot.api.sendMessage(chatId, "💬 Waiting for new message…", {
              message_thread_id: topicId,
            }).catch(() => {});
          }
          if (wantReceipt) {
            const text = formatReceipt({
              durationMs: rt.lastUserMessageAt ? doneAt - rt.lastUserMessageAt : 0,
              toolCount: rt.toolCount,
              outputTokens: receiptOutputDelta(processManager, chatId, topicId, rt, configDir),
            });
            await bot.api.sendMessage(chatId, `🧾 ${text}`, {
              message_thread_id: topicId,
              disable_notification: true,
            }).catch(() => {});
          }
          if (wantReview) {
            const project = getProject(chatId, topicId, configDir);
            if (project) {
              const diff = await collectGitDiff(diffCwdFor(chatId, topicId, project.path));
              // Dedup across turns: only prompt when there ARE changes and the
              // dirty state differs from what we last nagged about — an unchanged
              // tree left dirty turn after turn shouldn't re-prompt every time.
              if (shouldPromptReview(true, diff.hasChanges) && diff.signature !== rt.lastReviewSig) {
                rt.lastReviewSig = diff.signature;
                await bot.api.sendMessage(
                  chatId,
                  `🔍 This turn left uncommitted changes in ${project.name}. Review before more piles up?`,
                  {
                    message_thread_id: topicId,
                    reply_markup: {
                      inline_keyboard: [[
                        { text: "📄 Show diff", callback_data: reviewCallbackData("diff", chatId, topicId) },
                        { text: "🤖 Ask Claude to commit", callback_data: reviewCallbackData("commit", chatId, topicId) },
                        { text: "✔️ Leave it", callback_data: reviewCallbackData("leave", chatId, topicId) },
                      ]],
                    },
                  },
                ).catch(() => {});
              }
            }
          }
        }, 3000);
      }
      rt.lastReplyMsg = undefined;
      // The turn completed — everything delivered into it is accounted for.
      rt.clearTurn();
    }

    // API error — notify user
    if (event === "error") {
      // Read BEFORE any kill() call below — kill() tears down the process
      // state hasCancelPending reads from, so capturing it first is the only
      // way to know honestly whether a cancellation was requested for the
      // process that just failed.
      const wasCancelled = processManager.hasCancelPending(chatId, topicId);
      log(`[error] topic=${topicId} errorType=${text ?? "unknown"}${wasCancelled ? " (cancellation was pending)" : ""}`);
      const errorType = text ?? "unknown";
      // Note: this event means the TURN already failed terminally (StopFailure) —
      // don't promise automatic retries the killed process can't deliver.
      const messages: Record<string, string> = {
        rate_limit: "⚠️ Rate limited.",
        authentication_failed: "❌ Authentication failed — check your Claude subscription.",
        billing_error: "❌ Billing error — check claude.ai.",
        server_error: "⚠️ Claude API error.",
        max_output_tokens: "⚠️ Response too long — Claude hit the output limit.",
      };
      const baseMsg = messages[errorType] ?? `⚠️ Claude error: ${errorType}`;

      // A failed turn (StopFailure) leaves the Claude process alive but wedged: it
      // stops pulling new channel messages, so further messages are POSTed to the
      // channel server and silently never processed — until the user runs /new.
      // Auto-reset: persist the live session id, then kill the wedged process so
      // the next message respawns a fresh one (resuming context) with no manual /new.
      let recovered = false;
      let resendable: DeliveryEnvelope[] = [];
      // Read BEFORE takeResendable()/kill() — kill() synchronously fires
      // dispose(), which zeroes this counter along with the queue it describes.
      const evictedCount = rt.pendingEvictedCount;
      if (processManager.isRunning(chatId, topicId)) {
        const liveSession = processManager.getSessionId(chatId, topicId);
        if (liveSession) updateTopicSession(chatId, topicId, { sessionId: liveSession });
        log(`[error-recover] topic=${topicId} resetting wedged session (resume=${liveSession?.slice(0, 8) ?? "none"})`);
        // Snapshot BEFORE kill: kill() synchronously fires the "killed" event,
        // whose dispose() now clears rt.pendingTurn (every non-done process
        // death must drop stale envelopes — a StopFailure that lands after a
        // Cancel-turn kill must never resend the message the user just asked
        // to stop, and the old single-slot design was immune to this only by
        // accident, since each new message overwrote it). The cancelled branch
        // below must never take/resend, so skip the snapshot there entirely —
        // dispose() from this same kill() still empties the queue for us.
        if (!wasCancelled) resendable = rt.takeResendable();
        processManager.kill(chatId, topicId);
        recovered = true;
      }

      // A cancellation was requested for this process at some point in its
      // lifetime — never auto-resend the message whose work the user
      // explicitly asked to stop. This is the property the cancel-turn
      // feature depends on: an uncorrelated StopFailure must not be misread
      // as an ordinary failure and trigger the resend below.
      if (wasCancelled) {
        const msg = recovered
          ? "♻️ Session reset (a cancellation was in progress) — send a new message to continue."
          : "✅ Interrupt acknowledged.";
        await bot.api.sendMessage(chatId, msg, { message_thread_id: topicId }).catch(() => {});
        return;
      }

      // Re-deliver the message(s) that triggered the failed turn ourselves —
      // users often don't notice "send it again" and the work sits lost for
      // days. takeResendable marks every envelope BEFORE delivery, so a repeat
      // failure mid-resend can never loop; each resend reuses its original
      // delivery id (a fresh channel server has an empty dedupe, so it lands).
      const project = getProject(chatId, topicId, configDir);
      if (project && resendable.length > 0) {
        const what = resendable.length === 1 ? "your last message" : `your last ${resendable.length} messages`;
        // evictedCount > 0 means older messages fell off the 10-deep pendingTurn
        // queue before this failure happened — they can never be part of
        // `resendable`, so say so instead of implying everything was resent.
        const overflowNote = evictedCount > 0
          ? ` (${evictedCount} earlier message(s) couldn't be auto-resent — please resend those manually.)`
          : "";
        await bot.api.sendMessage(chatId, `${baseMsg}\n\n♻️ Session reset — resending ${what}.${overflowNote}`, {
          message_thread_id: topicId,
        }).catch(() => {});
        for (const envelope of resendable) {
          await sendToChannel(chatId, topicId, project.path, envelope.content, processManager, bot, configDir, { resend: true, deliveryId: envelope.id });
        }
        return;
      }

      const msg = recovered
        ? `${baseMsg}\n\n♻️ Session reset — send your message again to continue.`
        : baseMsg;
      await bot.api.sendMessage(chatId, msg, {
        message_thread_id: topicId,
      }).catch(() => {});
    }

    // Channels disabled org-wide — Claude Code can't receive any messages.
    // Fires per-topic (e.g. for every topic during boot auto-spawn), so DM the
    // owner ONCE rather than letting every topic fail silently in the dark.
    if (event === "channel_blocked") {
      log(`[channel_blocked] topic=${topicId} — channels disabled org-wide`);
      const now = Date.now();
      if (now - lastGlobalBlockedAlert > GLOBAL_BLOCKED_ALERT_WINDOW_MS) {
        lastGlobalBlockedAlert = now;
        const owners = authorizedIds(loadConfig(configDir));
        for (const owner of owners) {
          await bot.api.sendMessage(
            owner,
            "⚠️ Teleclaude: Channels are disabled at the org level — Claude Code can't " +
              "receive messages in any topic. Enable Channels at " +
              "claude.ai/admin-settings/claude-code, then send a message to resume.",
          ).catch(() => {});
        }
      }
    }

    // Tool stuck warning — watchdog detected a tool running too long
    if (event === "tool_stuck") {
      await showTurnWarning(bot, chatId, topicId, "soft", `⚠️ ${text ?? "A tool"} — may be stuck. Send a message, /cancel this turn, or /stop the session to intervene.`);
    }

    // Tool escalation — still running after 5 min, offer Cancel turn / Force stop session
    if (event === "tool_escalate") {
      const escToken = processManager.getCurrentTurnToken(chatId, topicId);
      const escButtons = escToken
        ? [[{ text: "⏹ Cancel turn", callback_data: `cancelturn:${topicId}:${escToken.seq}:${escToken.nonce}` }, { text: "🛑 Force stop session", callback_data: `forcestop:${topicId}:${escToken.seq}:${escToken.nonce}` }]]
        : [[{ text: "🛑 Force stop session", callback_data: `forcestop:${topicId}` }]];
      await showTurnWarning(bot, chatId, topicId, "hard", `🚨 ${text ?? "A tool"} — still running after 5 minutes.`, escButtons);
    }

    // Subagent lifecycle — show in activity
    if (event === "subagent_start") {
      log(`[subagent] topic=${topicId} subagent started`);
    }
    if (event === "subagent_stop") {
      log(`[subagent] topic=${topicId} subagent stopped`);
    }

    // mcp_failed is intentionally not surfaced to the user:
    // - PTY "N MCP servers failed" could be a global server or teleclaude-channel
    // - Fires during startup before channel server HTTP is ready (false alarm)
    // - Real failures are caught by replies=0 fallback in daemon.ts

    // Context compaction lifecycle
    if (event === "compact") {
      const spawnedAt = processManager.getSpawnedAt(chatId, topicId);
      const sinceSpawn = spawnedAt ? Date.now() - spawnedAt : Infinity;
      if (sinceSpawn < 15_000) {
        log(`[compact] topic=${topicId} suppressed — fired ${sinceSpawn}ms after spawn (likely session resume load)`);
      } else {
        log(`[compact] topic=${topicId} notifying user — context compacting`);
        await bot.api.sendMessage(chatId, "⚠️ Context full — compacting...", {
          message_thread_id: topicId,
          disable_notification: true,
        }).catch(() => {});
      }
    }

    if (event === "compacted") {
      log(`[compacted] topic=${topicId} compaction finished`);
      await bot.api.sendMessage(chatId, "✅ Context compacted. Earlier details may be summarized.", {
        message_thread_id: topicId,
        disable_notification: true,
      }).catch(() => {});
    }

    // Notify user when Claude disconnects unexpectedly
    if (event === "disconnected") {
      log(`[disconnected] topic=${topicId} unexpected exit`);
      // A death while a delivery is mid-spawn is sendToChannel's to report: it
      // retries (dropping an unresumable session id) and only then tells the user
      // if it truly couldn't get through. "Send a message to reconnect" on top of
      // that is both noise and wrong — the message is already on its way.
      if (rt.topicReady) {
        log(`[disconnected] topic=${topicId} notice suppressed — delivery still in flight`);
        return;
      }
      await bot.api.sendMessage(chatId, "Session disconnected. Send a message to reconnect.", {
        message_thread_id: topicId,
        disable_notification: true,
      }).catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) { log(`[msg:document] topic=${topicId} no project found`); return; }

    // Telegram bots cannot download files over 20MB — getFile refuses. Say so
    // up front instead of failing the download and losing the caption.
    const fileSize = ctx.message!.document!.file_size ?? 0;
    if (fileSize > 20 * 1024 * 1024) {
      await ctx.reply(
        `⚠️ Telegram bots can't download files over 20MB (this one is ${Math.round(fileSize / 1024 / 1024)}MB) — copy it into the project directory instead, or share a link.`,
        { message_thread_id: topicId },
      ).catch(() => {});
      return;
    }

    try {
      const inboxPath = join(project.path, INBOX_DIR);
      mkdirSync(inboxPath, { recursive: true });

      // basename(): the filename is sender-controlled — "../../x" must not
      // escape the inbox directory.
      const fileName = basename(ctx.message!.document!.file_name ?? "uploaded_file") || "uploaded_file";
      const filePath = join(inboxPath, fileName);
      log(`[msg:document] topic=${topicId} file=${fileName} project=${project.name}`);
      await downloadFile(bot, ctx.message!.document!.file_id, filePath);

      const caption = ctx.message!.caption;
      const prompt = caption
        ? `[File uploaded to ${filePath}] ${caption}`
        : `[File uploaded to ${filePath}] Read this file. Based on its content and the project structure, suggest where to organize it. If it's clear where it belongs, move it there.`;
      await sendToChannel(chatId, topicId, project.path, prompt, processManager, bot, configDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[msg:document] topic=${topicId} error: ${msg}`);
      await ctx.reply(`⚠️ Couldn't receive your file: ${msg} — please send it again.`, {
        message_thread_id: topicId,
      }).catch(() => {});
    }
  });

  bot.on("message:photo", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) { log(`[msg:photo] topic=${topicId} no project found`); return; }

    try {
      const inboxPath = join(project.path, INBOX_DIR);
      mkdirSync(inboxPath, { recursive: true });

      const photo = ctx.message!.photo!;
      const largest = photo[photo.length - 1];
      const fileName = `photo_${Date.now()}.jpg`;
      const filePath = join(inboxPath, fileName);
      log(`[msg:photo] topic=${topicId} file=${fileName} project=${project.name}`);
      await downloadFile(bot, largest.file_id, filePath);

      const caption = ctx.message!.caption;
      const prompt = caption
        ? `[Image uploaded to ${filePath}] ${caption}`
        : `[Image uploaded to ${filePath}] Read and analyze this image.`;
      await sendToChannel(chatId, topicId, project.path, prompt, processManager, bot, configDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[msg:photo] topic=${topicId} error: ${msg}`);
      await ctx.reply(`⚠️ Couldn't receive your file: ${msg} — please send it again.`, {
        message_thread_id: topicId,
      }).catch(() => {});
    }
  });

  bot.on("message:voice", async (ctx) => {
    const topicId = getTopicId(ctx.message!);
    if (!topicId || isGeneralTopic(topicId)) return;
    const chatId = ctx.chat.id;

    const project = getProject(chatId, topicId, configDir);
    if (!project) { log(`[msg:voice] topic=${topicId} no project found`); return; }

    log(`[msg:voice] topic=${topicId} project=${project.name}`);
    const oggPath = `/tmp/teleclaude-voice-${process.pid}-${Date.now()}.ogg`;
    try {
      await downloadFile(bot, ctx.message!.voice!.file_id, oggPath);
      const transcript = await transcribeVoice(oggPath);
      log(`[msg:voice] topic=${topicId} transcribed: ${transcript.slice(0, 80)}`);

      await bot.api.sendMessage(ctx.chat.id, `🎤 "${transcript}"`, {
        message_thread_id: topicId,
        disable_notification: true,
      });

      const caption = ctx.message!.caption;
      const prompt = caption ? `${transcript}\n\n${caption}` : transcript;
      await sendToChannel(chatId, topicId, project.path, prompt, processManager, bot, configDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[voice] error: ${msg}`);
      await ctx.reply(`Voice transcription failed: ${msg}`, {
        message_thread_id: topicId,
      }).catch(() => {});
    } finally {
      try { unlinkSync(oggPath); } catch { /* ignore */ }
    }
  });

  bot.on("message:text", async (ctx) => {
    const topicId = getTopicId(ctx.message);

    // General topic / direct message: project routing + pending ls name input
    if (isGeneralTopic(topicId)) {
      const chatId = ctx.chat.id;
      const text = ctx.message.text ?? "";
      const isPrivate = ctx.chat.type === "private";

      // /projectname content → route to matching project topic
      // Registered commands (/new, /list, ...) are consumed before this handler.
      const route = parseRouteCommand(text);
      if (route) {
        const allProjects = loadProjects(configDir).projects;
        const resolution = resolveRoute(allProjects, route.name);
        if (resolution.status === "ok") {
          const target = resolution.target;
          const groupChatId = target.chatId!;
          if (!(await isChatMember(bot.api, groupChatId, ctx.from!.id))) {
            // Same reply as an unknown project — don't leak which projects exist,
            // including the one just denied: the listed names are membership-
            // filtered too, or it would defeat its own disguise.
            log(`[msg:route] denied — user=${ctx.from!.id} is not a member of chat=${groupChatId}`);
            if (isPrivate) {
              const visible = await filterByMembership(bot.api, allProjects, ctx.from!.id);
              const names = visible.length ? visible.map((p) => p.name).join(", ") : "(none)";
              await ctx.reply(`⚠️ No project "${route.name}". Projects: ${names}`);
            }
            return;
          }
          log(`[msg:route] ${isPrivate ? "private" : "general"} → project=${target.name} chat=${groupChatId} topic=${target.topicId} content=${route.content.slice(0, 80)}`);
          const ack = await ctx.reply(`✅ → ${target.name}`, { reply_parameters: { message_id: ctx.message.message_id } });
          // Mirror into the topic so Claude's reply has visible context there
          await bot.api.sendMessage(groupChatId, `📨 ${route.content}`, {
            message_thread_id: target.topicId,
            disable_notification: true,
          }).catch(() => {});
          const result = await sendToChannel(groupChatId, target.topicId, target.path, route.content, processManager, bot, configDir);
          if (!result.ok) {
            // The topic-side failure notice lands where the DM user may not be
            // looking — correct the ✅ they DID see.
            await ctx.api.editMessageText(ctx.chat.id, ack.message_id,
              `⚠️ → ${target.name} — delivery failed (${result.reason}). Please send it again.`,
            ).catch(() => {});
          }
          return;
        }
        if (resolution.status === "no-chat") {
          await ctx.reply(`⚠️ No chat known for project "${resolution.target.name}" yet — send a message in its topic once first.`);
          return;
        }
        // Unknown project: give feedback in DMs; stay silent in the group
        // general topic so unrelated slash text keeps its old behavior.
        // The names list is membership-filtered like the denied branch above —
        // the two replies must stay indistinguishable, and a DM user should
        // only ever see projects from groups they belong to.
        if (isPrivate) {
          const visible = await filterByMembership(bot.api, allProjects, ctx.from!.id);
          const names = visible.length ? visible.map((p) => p.name).join(", ") : "(none)";
          await ctx.reply(`⚠️ No project "${route.name}". Projects: ${names}`);
          return;
        }
      }

      const pending = pendingLsName.get(chatId);
      if (pending) {
        pendingLsName.delete(chatId);
        const name = text.trim();
        if (name) {
          await createProjectFromPath(bot, chatId, undefined, name, pending, configDir);
        }
      }
      return; // general topic never routes to channel
    }

    const project = getProject(ctx.chat.id, topicId!, configDir);
    if (!project) { log(`[msg:text] topic=${topicId} no project found`); return; }

    log(`[msg:text] topic=${topicId} project=${project.name} text=${ctx.message.text.slice(0, 80)}`);
    // Threaded through so a reply to an ask_user "write my own" ForceReply
    // prompt can be matched back to that pending question (see channel-server.ts).
    const replyToMessageId = ctx.message.reply_to_message?.message_id;
    await sendToChannel(ctx.chat.id, topicId!, project.path, ctx.message.text, processManager, bot, configDir, { replyToMessageId, telegramMessageId: ctx.message.message_id });
  });
}

type ReadyResult = "ready" | "blocked" | "timeout" | "gone" | "died";

/**
 * Timeouts for the daemon→channel-server loopback fetches. Nothing here may
 * hang: Grammy handles updates sequentially, so ONE wedged channel server
 * would stall every topic's message handling behind it.
 *  - Readiness probe: one iteration of a 250ms poll loop that has its own
 *    overall deadline. 5s is generous for a loopback GET; anything slower is
 *    indistinguishable from a wedged server, and a timed-out iteration just
 *    polls again.
 *  - Delivery POST: the channel server can legitimately spend ~20s inside a
 *    POST (its own Telegram calls carry a 20s AbortSignal — see
 *    TELEGRAM_CALL_TIMEOUT_MS in channel-server.ts), so 30s never fires on a
 *    healthy server but bounds a wedged one. A timeout rejects exactly like a
 *    network failure and takes the existing retry/notify path.
 */
const READY_PROBE_TIMEOUT_MS = 5_000;
const CHANNEL_POST_TIMEOUT_MS = 30_000;

/** fetch with a hard upper bound — every loopback call in this file goes
 *  through this so no awaited daemon-side fetch can hang on a wedged socket.
 *  Exported for tests. */
export function loopbackFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Wait until the channel is actually usable — not just that its HTTP port is
 * bound. A green /ready only proves the MCP subprocess started; it does NOT
 * prove Claude Code registered the channel. If the org blocks channels, /ready
 * still returns 200 while inbound messages are silently dropped. So we also
 * consult the PTY-derived channel status:
 *   - status "blocked"    → return "blocked" immediately
 *   - status "registered" → return "ready" immediately
 *   - /ready 200 but status still "pending" → wait a short grace for a late
 *     block banner before declaring "ready" (covers Claude Code versions whose
 *     confirmation line we don't recognize).
 *
 * `gen` is the spawnToken of the process this wait belongs to. If the topic is
 * killed or restarted mid-wait (/stop, /new, /model), the token changes and we
 * return "gone" immediately — instead of spinning the full timeout and then
 * killing a process that belongs to a NEWER generation.
 *
 * "gone" (replaced by someone else — hands off) and "died" (this very process
 * exited on its own — ours to recover) are deliberately separate: conflating them
 * meant a Claude Code that crashed on startup was treated as a topic that had
 * moved on, so the message was dropped instead of retried.
 */
async function waitForReady(
  pm: ProcessManager,
  chatId: number,
  topicId: number,
  port: number,
  gen: string | undefined,
  timeoutMs = 60_000,
): Promise<ReadyResult> {
  const start = Date.now();
  let httpReadyAt = 0;
  while (Date.now() - start < timeoutMs) {
    // Token changed → a newer spawn (or a kill) owns this topic now: "gone".
    // Token intact but not running → this process exited by itself: "died".
    // kill() drops the map entry, so intentional kills always land on "gone".
    if (pm.getSpawnToken(chatId, topicId) !== gen) return "gone";
    if (!pm.isRunning(chatId, topicId)) return "died";
    const status = pm.getChannelStatus(chatId, topicId);
    // The HTTP probe is MANDATORY: a hook-driven "registered" says nothing about
    // the channel server having bound its port. See channel-ready.ts for what
    // each signal actually proves and what conflating them cost.
    let httpStatus = 0;
    try {
      // The token identifies the generation: a dying server from a previous
      // spawn can still be holding this recycled port, and its 200 would
      // otherwise mean "ready" for a process it has nothing to do with.
      const res = await loopbackFetch(`http://127.0.0.1:${port}/ready`, {
        headers: { "x-teleclaude-token": gen ?? "" },
      }, READY_PROBE_TIMEOUT_MS);
      httpStatus = res.status;
      if (httpStatus === 200) {
        if (!httpReadyAt) httpReadyAt = Date.now();
      } else {
        // 503 = server up but MCP not connected yet.
        // 409 = a server from a different spawn still holds the port.
        log(`[waitForReady] :${port} responded ${httpStatus}, waiting for MCP...`);
      }
    } catch {
      // Connection refused — server not started yet
    }
    const decision = readinessDecision({
      channelStatus: status,
      httpStatus,
      msSinceFirstHttpOk: httpReadyAt ? Date.now() - httpReadyAt : undefined,
      graceMs: CHANNEL_CONFIRM_GRACE_MS,
    });
    if (decision !== "wait") return decision;
    await new Promise((r) => setTimeout(r, 250));
  }
  return "timeout";
}

/** Kill the topic's process only if it is still the given generation — never
 *  kill a newer process that replaced the one a failure belongs to. */
function killIfSameGeneration(pm: ProcessManager, chatId: number, topicId: number, gen: string | undefined): void {
  if (gen && pm.getSpawnToken(chatId, topicId) === gen) pm.kill(chatId, topicId);
}

/** How long to wait for the channel to come back before retrying a POST that
 *  failed at the network level. */
const POST_RETRY_READY_TIMEOUT_MS = 30_000;

/**
 * POST the message to the topic's channel server, retrying once if the fetch
 * fails at the network level (connection refused/reset — not an HTTP error).
 *
 * A single "fetch failed" used to kill the session outright, which is a brutal
 * response to what is usually a timing artifact: the server is a subprocess
 * that binds its port seconds after Claude Code starts, and ports are recycled
 * between spawns. Readiness is re-verified (not merely slept on) before the
 * retry, and a topic that has since been killed or replaced is never retried —
 * the original error is rethrown so the caller's failure handling still runs
 * against the generation the POST was aimed at.
 */
async function postToChannel(
  pm: ProcessManager,
  chatId: number,
  topicId: number,
  port: number,
  gen: string | undefined,
  body: string,
): Promise<Response> {
  const attempt = () => loopbackFetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-teleclaude-token": gen ?? "" },
    body,
  }, CHANNEL_POST_TIMEOUT_MS);
  try {
    return await attempt();
  } catch (err) {
    if (pm.getSpawnToken(chatId, topicId) !== gen || !pm.isRunning(chatId, topicId)) throw err;
    logError(`[channel] POST to :${port} failed — re-checking readiness before one retry`, err);
    if (await waitForReady(pm, chatId, topicId, port, gen, POST_RETRY_READY_TIMEOUT_MS) !== "ready") throw err;
    log(`[channel] topic=${topicId} channel back on :${port} — retrying the POST`);
    return await attempt();
  }
}

/**
 * Outcome of a delivery attempt. Interactive callers ignore it (the user already
 * got a ⚠️ message on every failure path), but the scheduler needs it: a
 * scheduled run that never reached Claude must not be treated as done.
 */
export interface DeliveryResult {
  ok: boolean;
  /** Short human-readable failure cause, for logs and topic notices. */
  reason?: string;
}

const DELIVERED: DeliveryResult = { ok: true };

export async function sendToChannel(
  chatId: number,
  topicId: number,
  projectPath: string,
  content: string,
  pm: ProcessManager,
  bot: Bot,
  configDir?: string,
  opts?: { resend?: boolean; respawned?: boolean; replyToMessageId?: number; deliveryId?: string; telegramMessageId?: number },
): Promise<DeliveryResult> {
  const rt = topicRuntime(chatId, topicId);
  log(`[sendToChannel] chat=${chatId} topic=${topicId} running=${pm.isRunning(chatId, topicId)} content=${content.slice(0, 80)}`);

  // Heal a legacy chatId-less project (e.g. one that never had a session) so it
  // auto-spawns on boot and DM routing works.
  if (backfillProjectChat(chatId, topicId, configDir)) {
    log(`[sendToChannel] backfilled chatId for topic=${topicId}`);
  }
  // Persist chat ID + activity time for auto-spawn / DM routing
  updateTopicSession(chatId, topicId, { chatId, lastActiveAt: Date.now() });
  // Track time of last user message — used to cancel stale done notifications
  rt.lastUserMessageAt = Date.now();
  // One id per logical message, stable across retries — the channel server
  // dedupes it, so an at-least-once retry can't inject the same turn twice.
  // The envelope itself is queued only after a successful, non-consumed POST.
  const deliveryId = opts?.deliveryId ?? randomUUID();

  // Recently found this topic's channel blocked — don't respawn into the void.
  // Tell the user (responsive feedback) and skip until the cooldown lapses, at
  // which point we retry in case an admin re-enabled channels.
  const blockedAt = rt.channelBlockedAt;
  if (blockedAt && Date.now() - blockedAt < CHANNEL_BLOCKED_COOLDOWN_MS) {
    log(`[sendToChannel] topic=${topicId} channels blocked (cooldown) — not spawning`);
    await notifyChannelBlocked(bot, chatId, topicId);
    return { ok: false, reason: "channels are blocked org-wide" };
  }

  // Typing feedback from the moment the message is accepted — NOT only once
  // the POST lands. A cold topic spends 8-30s spawning + waiting for channel
  // readiness, and that whole stretch used to show nothing at all. Every
  // failure exit below stops it (directly, or via the kill → dispose path
  // that clears all timers).
  beginTurnTyping(bot, rt);

  // If another message is already spawning this topic, wait for it
  const pending = rt.topicReady;
  if (pending) {
    log(`[sendToChannel] topic=${topicId} waiting for pending spawn`);
    const readyPort = await pending;
    if (!readyPort) {
      log(`[sendToChannel] topic=${topicId} pending spawn failed`);
      stopTyping(rt);
      // The spawn's own notice covers the message that TRIGGERED the spawn —
      // this message was waiting on it and is lost separately, so say so.
      await bot.api.sendMessage(chatId, "⚠️ Claude Code failed to start, so your message wasn't delivered. Please send it again.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return { ok: false, reason: "Claude Code failed to start" };
    }
    // Port is ready, continue to POST below
  }

  // Set by the spawn closure below so the caller learns *why* it failed.
  let spawnFailure: string | undefined;
  let port: number;
  if (!pm.isRunning(chatId, topicId)) {
    log(`[sendToChannel] topic=${topicId} not running, spawning`);
    // Spawn and track the ready promise so concurrent messages wait.
    // Everything (including spawn itself) runs inside the try — a spawn throw
    // must still clear topicReady, or the topic is bricked until restart.
    const readyPromise = (async (): Promise<number | null> => {
      // The generation of the process THIS closure spawned (undefined until the
      // first pm.spawn returns). Declared outside the try so the catch below can
      // guard its cleanup kill: a throw before any spawn owns no generation and
      // must kill nothing.
      let gen: string | undefined;
      try {
        const saved = getTopicSession(chatId, topicId);
        const permissionMode = resolvePermissionMode(saved);
        const model = saved?.model ?? "sonnet";
        const doneNotify = saved?.doneNotify ?? false;
        let resumeId = saved?.sessionId || undefined;
        const resumeCwd = saved?.sessionCwd;
        log(`[sendToChannel] topic=${topicId} spawn config: model=${model} perms=${permissionMode} sessionId=${resumeId?.slice(0, 8) ?? "none"} cwd=${resumeCwd ?? "(root)"}`);

        // Resuming a transcript Claude Code's retention sweep already deleted is
        // fatal, and the dead id stays in sessions.json — so the topic keeps
        // dying on every message, including the ones the user resends by hand.
        // Drop the id up front and start a fresh session instead. Uses the same
        // resolveSpawnCwd pm.spawn applies internally (against the PERSISTED
        // sessionCwd, not a re-scan of every home — a session that relocated
        // since the last explicit /resume is a known, accepted staleness
        // window; see CLAUDE.md), so this early check and the later choke
        // point can never disagree about what counts as "missing".
        let staleResumeDropped = false;
        if (resumeId && !resolveSpawnCwd(resumeCwd, projectPath, resumeId).sessionId) {
          log(`[sendToChannel] topic=${topicId} resume ${resumeId.slice(0, 8)} expired at ${resumeCwd ?? projectPath} — starting a fresh session`);
          updateTopicSession(chatId, topicId, { sessionId: "", projectPath, sessionCwd: undefined });
          resumeId = undefined;
          staleResumeDropped = true;
          await notifySessionExpired(bot, chatId, topicId, resumeCwd);
        }

        // At most three spawns: the first, one retry for a cold start that
        // overran the ready timeout, and one retry after dropping a resume id
        // Claude Code turned out to reject.
        let coldStartRetried = false;
        let failure: "timeout" | "died" = "timeout";
        while (true) {
          const p = pm.spawn(chatId, topicId, projectPath, spawnSettingsFor(saved, { sessionId: resumeId, model, permissionMode, doneNotify, cwd: resumeId ? resumeCwd : undefined }));
          gen = pm.getSpawnToken(chatId, topicId);
          const result = await waitForReady(pm, chatId, topicId, p, gen);
          if (result === "gone") {
            // Killed or restarted mid-wait (/stop, /new, /model) — the topic
            // belongs to someone else now; don't touch it.
            log(`[channel] topic=${topicId} process replaced mid-spawn — dropping message`);
            spawnFailure = "the session was restarted mid-delivery";
            await bot.api.sendMessage(chatId, "⚠️ The session was restarted before your message was delivered. Please send it again.", {
              message_thread_id: topicId,
            }).catch(() => {});
            return null;
          }
          if (result === "blocked") {
            // Channels are off org-wide. Record it (gates respawns), kill the
            // useless process, and tell the user — don't POST into a dead channel.
            rt.channelBlockedAt = Date.now();
            spawnFailure = "channels are blocked org-wide";
            log(`[channel] topic=${topicId} blocked — not delivering message`);
            killIfSameGeneration(pm, chatId, topicId, gen);
            await notifyChannelBlocked(bot, chatId, topicId);
            return null;
          }
          if (result === "ready") {
            rt.channelBlockedAt = undefined; // healthy — clear any prior block
            log(`[channel] server ready on :${p} for topic=${topicId}`);
            return p;
          }
          // "died" or "timeout" — the process is useless either way. Clear it out
          // so the next iteration spawns clean instead of short-circuiting on the
          // exited entry still sitting in the map.
          killIfSameGeneration(pm, chatId, topicId, gen);
          if (result === "died") {
            logError(`[channel] topic=${topicId} Claude Code exited during startup (resume=${resumeId?.slice(0, 8) ?? "none"})`);
            // A rejected --resume is the one startup death worth retrying: it
            // fails identically forever until the id is dropped.
            if (resumeId && !staleResumeDropped) {
              staleResumeDropped = true;
              updateTopicSession(chatId, topicId, { sessionId: "", projectPath, sessionCwd: undefined });
              resumeId = undefined;
              await notifySessionExpired(bot, chatId, topicId, resumeCwd);
              continue;
            }
            failure = "died";
            break;
          }
          logError(`[channel] server on :${p} timed out starting for topic=${topicId}${coldStartRetried ? "" : " — retrying once"}`);
          if (coldStartRetried) { failure = "timeout"; break; }
          coldStartRetried = true;
        }
        spawnFailure = failure === "died" ? "Claude Code exited during startup" : "Claude Code timed out starting";
        await bot.api.sendMessage(
          chatId,
          failure === "died"
            ? "⚠️ Claude Code exited right after starting, so your message wasn't delivered. Try /new, then send it again."
            : "⚠️ Claude Code failed to start, so your message wasn't delivered. Please send it again.",
          { message_thread_id: topicId },
        ).catch(() => {});
        return null;
      } catch (err) {
        spawnFailure = "Claude Code failed to start";
        logError(`[channel] spawn failed for topic=${topicId}`, err);
        // Only tear down the process this closure actually spawned. gen is
        // undefined when the throw happened before/inside pm.spawn — then the
        // topic may be owned by a different generation, and we kill nothing.
        killIfSameGeneration(pm, chatId, topicId, gen);
        await bot.api.sendMessage(chatId, "⚠️ Claude Code failed to start, so your message wasn't delivered. Please send it again.", {
          message_thread_id: topicId,
        }).catch(() => {});
        return null;
      } finally {
        rt.topicReady = undefined;
      }
    })();
    rt.topicReady = readyPromise;

    const readyPort = await readyPromise;
    if (!readyPort) {
      // Most failure branches killed the process (dispose clears the typing
      // timers), but "gone" (replaced mid-spawn) doesn't — stop explicitly.
      stopTyping(rt);
      return { ok: false, reason: spawnFailure ?? "Claude Code failed to start" };
    }
    port = readyPort;
  } else {
    // Already running — but possibly still booting: /model, /permissions, /resume and
    // boot auto-spawn call pm.spawn() directly, and the PTY entry exists seconds
    // before the channel server binds its port. POSTing immediately would hit
    // ECONNREFUSED and (before this) kill the healthy, still-booting process.
    // waitForReady returns instantly once the channel is registered.
    const gen = pm.getSpawnToken(chatId, topicId);
    const p = pm.getPort(chatId, topicId)!;
    const result = await waitForReady(pm, chatId, topicId, p, gen);
    if (result === "blocked") {
      // e.g. spawned at boot while channels were org-blocked. Kill it so the
      // post-cooldown respawn can probe whether channels were re-enabled —
      // a blocked process never changes state on its own.
      rt.channelBlockedAt = Date.now();
      log(`[sendToChannel] topic=${topicId} running but channel blocked — not delivering`);
      killIfSameGeneration(pm, chatId, topicId, gen);
      await notifyChannelBlocked(bot, chatId, topicId);
      return { ok: false, reason: "channels are blocked org-wide" };
    }
    if (result === "died" && !opts?.respawned) {
      // The process we were about to POST to exited while we waited — typically a
      // boot auto-spawn or /model spawn that was still booting and crashed (e.g.
      // on a --resume id Claude Code rejects). Nothing has been delivered yet, so
      // start over: the spawn path below validates the resume id and respawns.
      // `respawned` bounds this to a single retry.
      log(`[sendToChannel] topic=${topicId} running process died before delivery — respawning`);
      killIfSameGeneration(pm, chatId, topicId, gen);
      return await sendToChannel(chatId, topicId, projectPath, content, pm, bot, configDir, { ...opts, respawned: true });
    }
    if (result !== "ready") {
      log(`[sendToChannel] topic=${topicId} running process never became ready (${result}) — dropping message`);
      killIfSameGeneration(pm, chatId, topicId, gen);
      await bot.api.sendMessage(chatId, "⚠️ Claude Code isn't responding, so your message wasn't delivered. Please send it again.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return { ok: false, reason: `the running session never became ready (${result})` };
    }
    port = p;
    log(`[sendToChannel] topic=${topicId} already running on :${port}`);
  }

  // Mint a fresh UI token for any "Cancel turn" button shown from this point
  // on, so a stale alert from an earlier delivery can't be tapped into
  // interrupting whatever runs next (see ProcessManager.beginTurn). This is
  // UI-only — it has no bearing on cancellation safety, which the sticky
  // cancelPending fence (ProcessManager.interruptTurn/hasCancelPending)
  // handles independently of turns.
  pm.beginTurn(chatId, topicId);
  const postGen = pm.getSpawnToken(chatId, topicId);
  try {
    log(`[sendToChannel] topic=${topicId} POSTing to :${port}`);
    const res = await postToChannel(pm, chatId, topicId, port, postGen, JSON.stringify({
      content,
      meta: {
        sender: "user",
        topic_id: String(topicId),
        delivery_id: deliveryId,
        ...(opts?.replyToMessageId ? { reply_to_message_id: String(opts.replyToMessageId) } : {}),
      },
    }));
    if (!res.ok) {
      logError(`[channel] POST to :${port} failed: ${res.status} ${await res.text()}`);
      // Same user-facing outcome as the network-error catch below: the message
      // did not reach Claude, and silence here means it sits lost for days.
      // No kill: an HTTP-level rejection is a live server refusing us, not the
      // dead-socket case the catch branch tears down.
      stopTyping(rt); // no kill on this path, so nothing else stops it
      await bot.api.sendMessage(chatId, "⚠️ Failed to deliver your message — please send it again.", {
        message_thread_id: topicId,
      }).catch(() => {});
      return { ok: false, reason: `the channel rejected the message (HTTP ${res.status})` };
    } else {
      // A normal chat POST gets back plain "ok" (or {duplicate:true} for a
      // retry whose first copy landed); only the ask_user relay branches
      // return consumed:true. Queue only real chat turns: relay verdicts
      // aren't turns, a resend is already queued (marked resent), and a
      // {duplicate:true} answer means the FIRST copy already queued it —
      // re-queuing here would let a later StopFailure replay a turn that
      // already completed.
      const bodyText = await res.text().catch(() => "");
      const flags = parseChannelResponseFlags(bodyText);
      if (!flags.consumed && !flags.duplicate && !opts?.resend) {
        rt.noteDelivered({ id: deliveryId, content, telegramMessageId: opts?.telegramMessageId, sentAt: Date.now(), resent: false });
      }
      // Typing started at message acceptance (top of sendToChannel); re-assert
      // in case anything stopped it during the spawn/readiness wait — including
      // a CONCURRENT delivery's failure path calling stopTyping on the shared
      // runtime (stopTyping isn't generation-aware; this re-assert is what
      // bounds that race to a dark stretch instead of a lost indicator).
      beginTurnTyping(bot, rt);
      // New delivered message = new turn for /receipts purposes.
      rt.toolCount = 0;
      const stallMs = stallTimeoutMs(configDir);
      const stallMin = Math.round(stallMs / 60_000);
      // Soft warning fires earlier and is purely informational (no buttons) —
      // relative to the hard threshold, not a flat low number: a couple of
      // minutes of turn-level silence is common during legitimate work, unlike
      // the tool-level case where a specific invocation is known to be running.
      const softMs = Math.max(60_000, stallMs - 120_000);
      const softMin = Math.round(softMs / 60_000);
      log(`[sendToChannel] topic=${topicId} POST ok, starting ${softMs / 1000}s/${stallMs / 1000}s response timeout`);
      // Start response timeout — detect silent failures (usage limit, stuck, etc.).
      // Cleared by any reply/done/error event; re-armed when it fires while a
      // tool is mid-flight, so a wedge AFTER the tool completes still alerts.
      const armStallTimer = () => {
        const stallHandle = rt.timers.setTimeout("stall", async () => {
          if (!pm.isRunning(chatId, topicId)) return;

          const lastTool = pm.getLastToolUse(chatId, topicId);
          if (lastTool) {
            // A tool is mid-flight — the stuck-tool watchdog already owns this case
            // (warns at 2 min, offers force-stop at 5 min). Don't double-notify.
            const elapsed = Math.round((Date.now() - lastTool.startedAt) / 1000);
            log(`[timeout] topic=${topicId} no reply in ${stallMs / 1000}s (tool ${lastTool.toolName} ${elapsed}s — watchdog owns it, re-arming)`);
            armStallTimer();
            return;
          }

          // No reply AND no active tool — Claude is stalled (e.g. retrying a failing
          // API call, like the StopFailure incident) or wedged. The tool watchdog
          // can't see this (no tool running), so surface it ourselves.
          log(`[timeout] topic=${topicId} stalled — no reply, no active tool in ${stallMs / 1000}s`);
          stopTyping(rt); // don't keep signaling activity that isn't happening
          const turnToken = pm.getCurrentTurnToken(chatId, topicId);
          const buttons = turnToken
            ? [[{ text: "⏹ Cancel turn", callback_data: `cancelturn:${topicId}:${turnToken.seq}:${turnToken.nonce}` }, { text: "🛑 Force stop session", callback_data: `forcestop:${topicId}:${turnToken.seq}:${turnToken.nonce}` }]]
            : [[{ text: "🛑 Force stop session", callback_data: `forcestop:${topicId}` }]];
          await showTurnWarning(bot, chatId, topicId, "hard", `⏳ No response in ${stallMin} min — Claude may be stuck (e.g. retrying the API).`, buttons);
        }, stallMs);

        if (softMs < stallMs) {
          rt.timers.setTimeout("softWarn", async () => {
            if (rt.timers.get("stall") !== stallHandle) return; // stall re-armed or cleared since
            if (!pm.isRunning(chatId, topicId)) return;
            if (pm.getLastToolUse(chatId, topicId)) return; // tool watchdog owns this case
            await showTurnWarning(bot, chatId, topicId, "soft", `⏳ Still working — ${softMin} min with no reply. Will alert again at ${stallMin} min if this continues.`);
          }, softMs);
        }
      };
      armStallTimer();
      return DELIVERED;
    }
  } catch (err) {
    logError(`[channel] POST to :${port} failed`, err);
    // Only kill the process this POST was aimed at — never a replacement that
    // arrived (e.g. via /new) while the fetch was in flight.
    killIfSameGeneration(pm, chatId, topicId, postGen);
    await bot.api.sendMessage(chatId, "⚠️ Failed to deliver your message — please send it again.", {
      message_thread_id: topicId,
    }).catch(() => {});
    return { ok: false, reason: "the channel POST failed" };
  }
}
