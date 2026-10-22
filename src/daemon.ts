import { Bot } from "grammy";
import { createServer } from "http";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig, authorizedIds, onProjectsChanged, ensureDir } from "./config.js";
import { syncBotCommands } from "./bot-commands.js";
import { log, logError } from "./log.js";
import { ProcessManager } from "./processes.js";
import { registerHandlers } from "./handlers/index.js";
import { loadSessionState, getTopicSession, updateTopicSession, isRecentlyActive, spawnSettingsFor, autoSpawnDecision } from "./session-state.js";
import { loadProjects, getProject } from "./config.js";
import { topicKey } from "./bot.js";
import { migrateToCompositeKeys, migrateBypassBoolean, countLegacyState } from "./migrate.js";
import { sweepProjectHooks } from "./hooks-config.js";
import { deriveOutcome, snippet } from "./tool-outcome.js";
import { DenialThrottle, denialKey, denialPreview, formatDenial } from "./permission-denied.js";
import { elicitationContextNote, elicitationDecline, elicitationSource, formatElicitationNotice } from "./elicitation.js";
import { SYSTEM_REMINDER } from "./channel-instructions.js";
import { getQuota, fmtResetIn, type QuotaBucket } from "./quota.js";
import { quotaAlertsFor, resetNoticeDelayMs, resetWindowKey, bucketLabel } from "./quota-watch.js";
import { consumeRestartMarker } from "./self-update.js";
import { startScheduler } from "./scheduler.js";
import { buildContinueOffer } from "./handlers/continue.js";
import { isChatMember, distinctProjectChatIds } from "./membership.js";
import { versionString } from "./version.js";
import { resolvePermissionMode } from "./permission-mode.js";
import { postToTopic } from "./channel-post.js";
import { topicRuntime } from "./topic-runtime.js";
import { forwardWithFallback } from "./forward-fallback.js";
import { isStaleMessage } from "./stale-updates.js";
import { handleWebhookRequest, CALLBACK_PORT as WEBHOOK_CALLBACK_PORT } from "./webhook.js";

// Single source of truth for the port, kept in webhook.js since it's the one
// module that needs to print the value back into a chat (/webhook command).
const CALLBACK_PORT = WEBHOOK_CALLBACK_PORT;

// Foreign-session hooks (terminal Claude sessions sharing settings.local.json)
// fire on every tool use — log each foreign (topic, token/session) once, not
// thousands of times a day.
const loggedForeignHooks = new Set<string>();
function logForeignHookOnce(dedupeKey: string, message: string): void {
  if (loggedForeignHooks.has(dedupeKey)) return;
  if (loggedForeignHooks.size > 1000) loggedForeignHooks.clear();
  loggedForeignHooks.add(dedupeKey);
  log(message);
}

// Polling health check — detect zombie state after sleep/network loss
const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000;

/** Cap on a hook callback body. The biggest legitimate one carries Claude's last
 *  message; an unbounded read would let a single caller grow the heap at will. */
const MAX_CALLBACK_BODY_BYTES = 8 * 1024 * 1024;

// Auto-mode denials arrive in bursts as Claude retries the same blocked action.
// Keyed per (chat:topic, tool, input) so distinct blocks still all get through.
const denialThrottle = new DenialThrottle();

export async function startDaemon(token: string, configDir?: string): Promise<void> {
  process.on("uncaughtException", (err) => {
    logError("[FATAL] uncaughtException:", err.stack ?? err.message);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logError("[warn] unhandledRejection:", msg);
  });

  log("Starting teleclaude v2...");

  // Tighten ~/.teleclaude to 0700 on every boot, not just the next
  // saveConfig/saveProjects — an already-installed instance that predates the
  // 0700 hardening otherwise stays loose (0755) until something happens to
  // write one of those files. Best-effort and must never throw here: this
  // runs before the uncaughtException handler would otherwise just exit and
  // let KeepAlive loop forever on a permissions quirk.
  try {
    ensureDir(configDir ?? join(homedir(), ".teleclaude"));
  } catch (err) {
    logError("[boot] ensureDir failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // One-time upgrade: re-key state from topic-id-only to composite (chat:topic) keys.
  migrateToCompositeKeys(configDir);

  // Write back the legacy bypass boolean, then report what legacy state
  // remains. A release whose boots report zeros makes it safe for the NEXT
  // release to delete the migration read paths (composite-key re-keying, the
  // bypass fallback, the chatId-less project fallbacks). Deletion is
  // deliberately deferred — an install that skipped versions may still carry
  // legacy state. Must run before loadSessionState below reads the file.
  migrateBypassBoolean(configDir);
  const legacy = countLegacyState(configDir);
  if (legacy.legacySessionKeys || legacy.bypassFields || legacy.chatlessProjects) {
    log(`[migrate] legacy state present: sessionKeys=${legacy.legacySessionKeys} bypassFields=${legacy.bypassFields} chatlessProjects=${legacy.chatlessProjects} — migration read paths still needed`);
  } else {
    log(`[migrate] no legacy state remains — migration read paths are deletable in a follow-up release`);
  }

  // Before anything spawns: every teleclaude callback URL sitting in a project's
  // settings.local.json right now is dead (its spawn token died with the last
  // daemon), and hooks for retired events never get swept in projects we don't
  // spawn — they keep POSTing on every prompt of the user's *terminal* sessions.
  // Spawning re-adds live hooks, so removing them here costs nothing.
  try {
    const sweep = sweepProjectHooks(
      loadProjects(configDir).projects.map((p) => p.path),
      `http://127.0.0.1:${CALLBACK_PORT}`,
    );
    if (sweep.removed > 0) {
      log(`[hooks:sweep] removed ${sweep.removed} dead hook(s) across ${sweep.changed}/${sweep.scanned} project settings files`);
    }
  } catch (err) {
    // Never let a settings-file problem stop the daemon from starting.
    logError("[hooks:sweep] failed:", err instanceof Error ? err.message : String(err));
  }

  loadSessionState(configDir);
  const config = loadConfig(configDir);
  const allowedIds = authorizedIds(config);
  log(`[auth] ${allowedIds.length} authorized user(s): ${allowedIds.join(", ")}`);
  const pm = new ProcessManager(token, configDir);

  const bot = new Bot(token);

  // Boot auto-spawn timers — kept so shutdown can cancel spawns that haven't
  // fired yet instead of racing them against killAll().
  const bootSpawnTimers: NodeJS.Timeout[] = [];

  // The bot's own pinChatMessage (session-pin.ts) posts a "pinned a message"
  // service message into the topic — delete it so the pinned bar is the only
  // visible trace. Must be registered BEFORE the auth middleware: the service
  // message's `from` is the bot itself, which the whitelist silently drops.
  // Scoped to the bot's own pins; a human pinning something falls through.
  bot.on("message:pinned_message", async (ctx, next) => {
    if (ctx.message.from?.id === ctx.me.id) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      return;
    }
    await next();
  });

  // Auth middleware — silently ignore messages from users not on the whitelist
  bot.use(async (ctx, next) => {
    if (!ctx.from || !allowedIds.includes(ctx.from.id)) return;
    await next();
  });

  // Retained-on-restart messages are processed; a long-outage backlog is skipped.
  bot.use(async (ctx, next) => {
    if (ctx.message && isStaleMessage(ctx.message.date, Date.now())) {
      log(`[stale] skipping update ${ctx.update.update_id} — message is ${Math.round(Date.now() / 1000 - ctx.message.date)}s old`);
      return;
    }
    await next();
  });

  registerHandlers(bot, pm, configDir);
  startScheduler(bot, pm, configDir);

  // Telegram's command menu. Synced once at boot, then whenever the project
  // list changes (the menu carries /<project> shortcuts), debounced so a burst
  // of edits is one round of API calls.
  void syncBotCommands(bot, configDir);
  let menuTimer: NodeJS.Timeout | undefined;
  onProjectsChanged(() => {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = setTimeout(() => { void syncBotCommands(bot, configDir); }, 2_000);
    menuTimer.unref();
  });

  // Without this, one throwing handler ends the polling loop: bot.start() isn't
  // awaited, so the rejection is swallowed and the health watchdog later kills
  // every running session for what was a single bad update.
  bot.catch((err) => {
    const e = err.error;
    logError(`[bot] handler error (update ${err.ctx?.update?.update_id ?? "?"}):`, e instanceof Error ? e.stack ?? e.message : String(e));
  });

  // Callback server — receives:
  // 1. Reply callbacks from channel server (with message_id, chat_id)
  // 2. Stop hook POSTs from Claude Code when a turn finishes
  const callbackServer = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const url = new URL(req.url ?? "", `http://127.0.0.1:${CALLBACK_PORT}`);

    // Inbound webhook: a completely separate auth scheme (a per-project token
    // in a header, not the query-string spawn token below) for a completely
    // separate caller (an external process the user wired up, not Claude
    // Code's own hooks). Dispatched here, before the hook guard reads
    // `topic`/`chat`/`token` from the query string, so the two schemes never
    // interfere — a webhook POST is never subjected to the hook guard's checks,
    // and vice versa. Still localhost-only: this is the same 127.0.0.1-bound
    // server as everything else here.
    if (url.pathname === "/webhook") {
      await handleWebhookRequest(req, res, bot, pm, configDir);
      return;
    }

    const topicId = Number(url.searchParams.get("topic"));
    const chatId = Number(url.searchParams.get("chat"));
    const key = topicKey(chatId, topicId);
    const hookEvent = url.searchParams.get("event");
    const hookToken = url.searchParams.get("token");

    /** Answer and drain, so a rejected caller doesn't leave a socket hanging. */
    const reject = (status: number, note?: string): void => {
      if (note) logForeignHookOnce(`${key}:${note}`, `[callback] ${note}`);
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
      req.resume();
    };

    // Primary guard, and it runs BEFORE the body is read: everything it needs is
    // in the query string. Each teleclaude session embeds a unique random token in
    // every hook URL, so a Claude Code session in the same directory (or any other
    // local process) can't forge events for a topic. Requests without a usable
    // (chat, topic) pair used to skip this check entirely and fall through to the
    // "unhandled" log line, which let any local process write to the daemon log.
    if (!topicId || !chatId) {
      reject(400, `bad-target topic=${url.searchParams.get("topic")} chat=${url.searchParams.get("chat")} event=${hookEvent} (logged once)`);
      return;
    }
    const expectedToken = pm.getSpawnToken(chatId, topicId);
    if (!expectedToken || hookToken !== expectedToken) {
      reject(200, `topic=${topicId} rejecting ${expectedToken ? "token-mismatch" : "no-process"} hooks (likely terminal session; logged once)`);
      return;
    }
    // A token-valid request proves this spawn's Claude Code is running turns —
    // the authoritative "channel registered" signal (the PTY confirmation
    // banner isn't printed by current Claude Code versions). Stops startup
    // PTY logging and lets waitForReady return instantly.
    pm.markChannelRegistered(chatId, topicId);

    // Only now read the body, and cap it: hook payloads are small (the largest
    // carries Claude's last message), while an unbounded read lets one caller
    // grow the daemon's heap without limit.
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const c of req) {
      const chunk = c as Buffer;
      received += chunk.length;
      if (received > MAX_CALLBACK_BODY_BYTES) {
        log(`[callback] topic=${topicId} body over ${MAX_CALLBACK_BODY_BYTES} bytes — rejecting ${hookEvent}`);
        reject(413);
        return;
      }
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();
    let body: any = {};
    try { body = JSON.parse(rawBody); } catch { /* empty body is fine for Stop hook */ }

    // Most hooks want an empty acknowledgement; a decision hook overwrites this.
    let hookResponse = "{}";
    // Past this point the request is authenticated for this topic.

    // Secondary guard: session ID check for defense-in-depth.
    if (hookEvent && body.session_id) {
      if (!pm.isRunning(chatId, topicId)) {
        logForeignHookOnce(`${key}:norun:${body.session_id}`, `[callback] topic=${topicId} ignoring hooks — no active session (logged once)`);
        res.writeHead(200).end("{}");
        return;
      }
      const known = pm.getSessionId(chatId, topicId);
      if (known && known !== body.session_id) {
        logForeignHookOnce(`${key}:sess:${body.session_id}`, `[callback] topic=${topicId} ignoring hooks — session mismatch (${body.session_id.slice(0, 8)} != ${known.slice(0, 8)}; logged once)`);
        res.writeHead(200).end("{}");
        return;
      }
      // Register session ID from first hook if we don't have it yet (new session, not
      // resumed) and persist it so the conversation survives a daemon restart/deploy.
      if (!known) {
        pm.registerSessionId(chatId, topicId, body.session_id);
        updateTopicSession(chatId, topicId, { sessionId: body.session_id });
      }
    }

    if (body.event === "reply") {
      topicRuntime(chatId, topicId).replyCount += 1;
      pm.clearToolUse(chatId, topicId);
      pm.handleCallback(chatId, topicId, "reply", { messageId: body.message_id, text: body.text });
    } else if (hookEvent === "error") {
      pm.clearToolUse(chatId, topicId);
      pm.handleCallback(chatId, topicId, "error", { text: body.error_type ?? body.hook_event_name ?? "unknown" });
    } else if (hookEvent === "compact") {
      pm.handleCallback(chatId, topicId, "compact");
    } else if (hookEvent === "compacted") {
      pm.handleCallback(chatId, topicId, "compacted");
      // Re-inject system reminder so Claude retains channel behavior after compaction
      void postToTopic(pm, chatId, topicId, "", { content: SYSTEM_REMINDER, meta: { sender: "system" } }).catch(() => {});
    } else if (hookEvent === "done") {
      pm.clearToolUse(chatId, topicId);
      // Bump activity on any completed turn (user OR cron) so cron-driven sessions
      // stay "recent" and keep auto-spawning on boot.
      updateTopicSession(chatId, topicId, { lastActiveAt: Date.now() });
      const lastMsg = String(body.last_assistant_message ?? "").trim();
      if (lastMsg) log(`[done:msg] topic=${topicId} last_msg=${lastMsg.slice(0, 200)}`);
      const doneRt = topicRuntime(chatId, topicId);
      const replyCount = doneRt.replyCount;
      doneRt.replyCount = 0;
      pm.handleCallback(chatId, topicId, "done");
      const donePort = pm.getPort(chatId, topicId);
      if (donePort) {
        // If Claude responded with text but never called the reply tool, send it
        // straight to Telegram via /forward — no extra Claude turn involved.
        // Awaited so the /done render below can't interleave with the forward.
        if (replyCount === 0 && lastMsg) {
          log(`[done:fallback] topic=${topicId} forwarding last_msg (replies=0)`);
          // /forward first (formatted); on any failure fall back to sending the
          // raw text directly — the answer is in hand here, and a wedged channel
          // server must cost formatting at worst, never the reply itself.
          await forwardWithFallback({
            topicId,
            port: donePort,
            token: pm.getSpawnToken(chatId, topicId) ?? "",
            text: lastMsg,
            sendDirect: (chunk) => bot.api.sendMessage(chatId, chunk, { message_thread_id: topicId }),
          });
          // The fallback message send is complete — signal "final update sent" so the
          // typing indicator can stop precisely (not on a blind timer).
          pm.handleCallback(chatId, topicId, "forwarded");
        }
        // Clear activity line on the channel server
        void postToTopic(pm, chatId, topicId, "/done", {
          background_task_count: body.background_tasks?.length ?? 0,
        }).catch(() => {});
      }
    } else if (hookEvent === "tool_use" && body.tool_name === "AskUserQuestion") {
      // No interactive terminal in a Telegram-hosted session, so the built-in
      // picker would just hang forever waiting for a keypress nobody can send.
      // Deny it before it ever renders and point Claude at our own blocking
      // ask_user tool instead (ask-relay.ts + channel-server.ts), which relays
      // the same questions to real Telegram buttons and returns a real answer.
      // A denied call never executes, so — unlike the branch below — this
      // deliberately skips trackToolUse/tool_use forwarding: there is no
      // PostToolUse coming to disarm the stuck-tool watchdog for it.
      log(`[callback] topic=${topicId} denying AskUserQuestion — redirecting to ask_user`);
      hookResponse = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "This session is Telegram-hosted with no interactive terminal.",
          additionalContext: "Call the ask_user tool instead, with the same questions — it relays them to Telegram as buttons and returns the user's real answer.",
        },
      });
    } else if (hookEvent === "tool_use") {
      const port = pm.getPort(chatId, topicId);
      if (port) {
        const toolInput = body.tool_name === "Bash" && body.tool_input?.command
          ? ` cmd=${String(body.tool_input.command).slice(0, 120)}`
          : "";
        log(`[callback] topic=${topicId} tool_use tool=${body.tool_name}${toolInput}`);
        pm.trackToolUse(chatId, topicId, body.tool_name, body.tool_input?.command);
        // Surface tool activity to the event handler so the typing indicator stays
        // alive through long tool phases (even after an intermediate Stop/done).
        pm.handleCallback(chatId, topicId, "tool_use");
        void postToTopic(pm, chatId, topicId, "/tool", { tool_name: body.tool_name, tool_input: body.tool_input, agent_id: body.agent_id }).catch(() => {});
      }
    } else if (hookEvent === "tool_use_post") {
      // PostToolUse: one tool completed — watchdog stands down only when no
      // parallel sibling is still running
      log(`[callback] topic=${topicId} tool_use_post tool=${body.tool_name}`);
      pm.toolCompleted(chatId, topicId);
      const { ok, errorSnippet } = deriveOutcome(body.tool_response);
      // Also tell the channel server: a completed tool is evidence that a
      // permission prompt for it was answered at the terminal, which it is
      // otherwise never told about (permission-relay.ts). Now also carries the
      // outcome (live-turn-view) so the running turn view can show success/
      // failure per tool instead of only "done".
      if (body.tool_name) {
        void postToTopic(pm, chatId, topicId, "/tool-post", {
          tool_name: body.tool_name,
          tool_input: body.tool_input,
          ok,
          duration_ms: body.duration_ms,
          error_snippet: errorSnippet,
          agent_id: body.agent_id,
        }).catch(() => {});
      }
      // The Agent tool's response carries the subagent id it just kicked off;
      // forward the caller-supplied description as that subagent's label so
      // the turn view can show something more meaningful than an id.
      if (body.tool_name === "Agent" && body.tool_response && typeof body.tool_response === "object") {
        const agentId = (body.tool_response as Record<string, unknown>).agentId;
        if (typeof agentId === "string") {
          void postToTopic(pm, chatId, topicId, "/subagent", {
            event: "label",
            agent_id: agentId,
            label: body.tool_input?.description,
          }).catch(() => {});
        }
      }
    } else if (hookEvent === "tool_failed") {
      // PostToolUseFailure: a tool that errors emits this INSTEAD of
      // PostToolUse — without decrementing here, the stuck-tool watchdog's
      // in-flight count never comes back down for a failed call.
      log(`[callback] topic=${topicId} tool_failed tool=${body.tool_name}`);
      pm.toolCompleted(chatId, topicId);
      const { errorSnippet } = deriveOutcome(body.tool_response);
      const fallbackSnippet = errorSnippet
        ?? (typeof body.error === "string" ? snippet(body.error) : undefined);
      if (body.tool_name) {
        void postToTopic(pm, chatId, topicId, "/tool-post", {
          tool_name: body.tool_name,
          tool_input: body.tool_input,
          ok: false,
          duration_ms: body.duration_ms,
          error_snippet: fallbackSnippet,
          agent_id: body.agent_id,
        }).catch(() => {});
      }
    } else if (hookEvent === "permission_denied") {
      // Auto mode blocked a tool call. Nobody is watching the TUI notification
      // or /permissions, so forward it — otherwise Claude just quietly does
      // something else and the user can't tell why the answer changed shape.
      const preview = denialPreview(String(body.tool_name ?? "?"), body.tool_input);
      const toolName = String(body.tool_name ?? "unknown tool");
      log(`[callback] topic=${topicId} permission_denied tool=${toolName}${preview ? ` input=${preview}` : ""}`);
      if (denialThrottle.shouldNotify(`${key} ${denialKey(toolName, preview)}`, Date.now())) {
        // Plain text deliberately: the preview is a raw shell command or path,
        // and no parse_mode means nothing in it can break the send.
        await bot.api.sendMessage(chatId, formatDenial(toolName, preview), {
          message_thread_id: topicId,
        }).catch((err) => log(`[callback] topic=${topicId} denial notice failed: ${err}`));
      } else {
        log(`[callback] topic=${topicId} permission_denied notice throttled`);
      }
    } else if (hookEvent === "elicitation") {
      // Decline rather than let the turn hang on a dialog nobody can see. The
      // hook response IS the answer and it's synchronous, so there's no way to
      // wait for a Telegram tap without stalling the turn for as long as it takes.
      const source = elicitationSource(body);
      log(`[callback] topic=${topicId} elicitation from ${source} — declining (no interactive terminal)`);
      hookResponse = elicitationDecline();
      await bot.api.sendMessage(chatId, formatElicitationNotice(source), {
        message_thread_id: topicId,
      }).catch((err) => log(`[callback] topic=${topicId} elicitation notice failed: ${err}`));
      // Tell Claude too, so it re-asks through the reply tool instead of retrying.
      void postToTopic(pm, chatId, topicId, "", { content: elicitationContextNote(source), meta: { sender: "system" } }).catch(() => {});
    } else if (hookEvent === "subagent_start") {
      log(`[callback] topic=${topicId} subagent_start`);
      pm.handleCallback(chatId, topicId, "subagent_start");
      void postToTopic(pm, chatId, topicId, "/subagent", {
        event: "start",
        agent_id: body.agent_id,
        agent_type: body.agent_type,
        last_assistant_message: body.last_assistant_message,
      }).catch(() => {});
    } else if (hookEvent === "subagent_stop") {
      log(`[callback] topic=${topicId} subagent_stop`);
      pm.handleCallback(chatId, topicId, "subagent_stop");
      void postToTopic(pm, chatId, topicId, "/subagent", {
        event: "stop",
        agent_id: body.agent_id,
        agent_type: body.agent_type,
        last_assistant_message: body.last_assistant_message,
      }).catch(() => {});
    } else if (hookEvent === "narration") {
      // MessageDisplay: streamed assistant-message chunks. High frequency by
      // design (one per delta), so deliberately not logged per-event — the
      // existing per-branch log line would flood the daemon log for no
      // operational benefit. Fire-and-forget forward like every other branch
      // here; the channel server tolerates missing fields.
      void postToTopic(pm, chatId, topicId, "/narration", {
        delta: body.delta,
        index: body.index,
        final: body.final,
        message_id: body.message_id,
        prompt_id: body.prompt_id,
      }).catch(() => {});
    } else if (hookEvent === "task_created" || hookEvent === "task_completed") {
      log(`[callback] topic=${topicId} forwarding ${hookEvent} to channel server :${pm.getPort(chatId, topicId)}`);
      void postToTopic(pm, chatId, topicId, "/task", { event: hookEvent, task_id: body.task_id ?? body.task_subject, task_subject: body.task_subject }).catch(() => {});
    } else {
      log(`[callback] topic=${topicId} unhandled: hookEvent=${hookEvent} bodyEvent=${body.event}`);
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(hookResponse);
  });
  // Bound how long a request may sit open end-to-end. Node's own default
  // (300s) already isn't "disabled" (requestTimeout: 0), but it's far more
  // than any legitimate hook or webhook body needs on a loopback socket — a
  // wedged or slow-drip client could otherwise hold this single dispatch
  // loop's connection for 5 minutes. Set explicitly rather than relying on
  // the default so the bound is visible here and doesn't silently drift if
  // Node's default ever changes.
  callbackServer.requestTimeout = 30_000;
  callbackServer.headersTimeout = 10_000;
  callbackServer.listen(CALLBACK_PORT, "127.0.0.1", () => {
    log(`Callback server on :${CALLBACK_PORT}`);
  });

  bot.start({
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"],
    onStart: () => {
      log("Teleclaude v2 is running.");

      // A chat-triggered /update or /restart left a marker — confirm we're back.
      const marker = consumeRestartMarker(configDir);
      if (marker) {
        log(`[self-update] confirming restart to chat=${marker.chatId} (${marker.note})`);
        bot.api.sendMessage(marker.chatId, `✅ Back online — ${versionString()} (${marker.note})`, {
          ...(marker.topicId ? { message_thread_id: marker.topicId } : {}),
        }).catch(() => {});
      }

      // Auto-spawn sessions staggered (5s apart to avoid overwhelming the system)
      // Auto-spawn sessions that are persisted AND were active recently. Stale ones
      // aren't spawned (bounds boot load with many projects) — they still resume on
      // the next message. Legacy entries with no lastActiveAt are treated as active.
      const RECENT_MS = 48 * 60 * 60 * 1000;
      const now = Date.now();
      const projects = loadProjects(configDir).projects;
      let delay = 0;
      for (const project of projects) {
        const chatId = project.chatId;
        if (!chatId) {
          log(`[auto-spawn] skipping project=${project.name} topic=${project.topicId} — no chatId`);
          continue;
        }
        const saved = getTopicSession(chatId, project.topicId);
        const recent = isRecentlyActive(saved?.lastActiveAt, now, RECENT_MS);
        log(`[auto-spawn] checking project=${project.name} chat=${chatId} topic=${project.topicId} sessionId=${saved?.sessionId?.slice(0, 8) ?? "none"} recent=${recent}`);
        if (saved?.sessionId && recent) {
          const p = project;
          bootSpawnTimers.push(setTimeout(() => {
            try {
              // Re-read everything at fire time: a /new, /delete or /model in
              // the stagger window must win over what boot saw. (/stop is NOT
              // in this list — it deliberately leaves sessionId/lastActiveAt
              // set so the topic resumes on the next message/schedule/boot;
              // a queued auto-spawn firing after a bare /stop is that same
              // resume contract, not a bug this re-read is meant to prevent.)
              const freshProject = getProject(chatId, p.topicId, configDir);
              const freshSaved = getTopicSession(chatId, p.topicId);
              const decision = autoSpawnDecision({
                project: freshProject,
                projectPathExists: !!freshProject && existsSync(freshProject.path),
                saved: freshSaved,
                now: Date.now(),
                recentMs: RECENT_MS,
              });
              if (!decision.spawn) {
                log(`[auto-spawn] skipping chat=${chatId} topic=${p.topicId} (${p.name}) — ${decision.reason}`);
                return;
              }
              log(`[auto-spawn] spawning chat=${chatId} topic=${p.topicId} (${p.name}) session=${freshSaved!.sessionId.slice(0, 8)} model=${freshSaved!.model ?? "sonnet"} perms=${resolvePermissionMode(freshSaved)}`);
              pm.spawn(chatId, p.topicId, freshProject!.path, spawnSettingsFor(freshSaved));
            } catch (err) {
              // pty.spawn can throw synchronously (renamed dir, broken claude
              // binary). Uncaught, that hits the fatal handler → process.exit →
              // KeepAlive restart → same throw: a permanent crash loop taking
              // every OTHER topic down with it. Log, tell the topic, move on.
              logError(`[auto-spawn] spawn failed for ${p.name}:`, err instanceof Error ? err.stack ?? err.message : String(err));
              bot.api.sendMessage(chatId, "⚠️ Couldn't restore this project's session at startup — send a message to retry, or check the daemon log.", {
                message_thread_id: p.topicId,
              }).catch(() => {});
            }
          }, delay));
          delay += 5000;
        }
      }
      if (delay > 0) log(`[auto-spawn] ${delay / 5000} sessions queued, ${delay / 1000}s total`);
      if (delay === 0) log(`[auto-spawn] no sessions to auto-spawn`);
    },
  });

  // Proactive quota alerts — a stalled-at-100% bucket looks like a silent
  // multi-hour hang from Telegram; warn owners before it happens. One alert
  // per (bucket, level, reset window); the set re-arms itself when the window
  // rolls over. At 100% we send a single red "exhausted" message and then a
  // one-shot notice when the bucket actually resets — no 10-minute repeats.
  const quotaPct = config.defaults.quotaAlertPercent;
  const quotaAlerted = new Set<string>();
  const resetTimers = new Map<string, NodeJS.Timeout>();

  const notifyOwners = async (text: string): Promise<void> => {
    for (const owner of allowedIds) {
      await bot.api.sendMessage(owner, text).catch(() => {});
    }
  };

  const scheduleResetNotice = (field: string, resetsAt: string | null, attempt = 0): void => {
    const label = bucketLabel(field);
    const delay = resetNoticeDelayMs(resetsAt, Date.now());
    if (delay == null) {
      log(`[quota-alert] ${label} — no usable reset time (${resetsAt ?? "null"}), skipping reset notice`);
      return;
    }
    const prev = resetTimers.get(field);
    if (prev) clearTimeout(prev);
    log(`[quota-alert] ${label} reset notice scheduled in ${Math.round(delay / 60_000)}m (at ${resetsAt})`);
    const timer = setTimeout(() => {
      resetTimers.delete(field);
      void (async () => {
        let bucket: QuotaBucket | null | undefined;
        let checked = false;
        try {
          const fresh = await getQuota();
          if (fresh) {
            checked = true;
            bucket = fresh[field as keyof typeof fresh] as QuotaBucket | null | undefined;
          }
        } catch { /* treated as unchecked below */ }
        // Never claim "reset" on evidence we don't have: an unreachable quota API
        // means unknown, not available. Re-arm and look again.
        if (!checked && attempt < 5) {
          log(`[quota-alert] ${label} reset check failed — re-arming (attempt ${attempt + 1})`);
          scheduleResetNotice(field, resetsAt, attempt + 1);
          return;
        }
        // Still capped past the reset time — the window slipped; re-arm off the
        // fresh reset time a few times before reporting anyway.
        if (bucket?.utilization != null && bucket.utilization >= 100 && attempt < 5) {
          scheduleResetNotice(field, bucket.resets_at, attempt + 1);
          return;
        }
        const pct = bucket?.utilization;
        const suffix = !checked
          ? " — though I couldn't reach the quota API to confirm"
          : pct == null ? "" : pct >= 100
            ? ` — but it still reports 100%${fmtResetIn(bucket?.resets_at ?? null)}`
            : ` (now at ${pct.toFixed(0)}%)`;
        log(`[quota-alert] ${label} reset notice sent${suffix}`);
        await notifyOwners(`🟢 Claude quota reset — ${label} should be available again${suffix}.`);
      })();
    }, delay);
    timer.unref();
    resetTimers.set(field, timer);
  };

  const checkQuota = async (): Promise<void> => {
    try {
      const q = await getQuota();
      if (!q) return;
      for (const alert of quotaAlertsFor(q, quotaPct, quotaAlerted)) {
        quotaAlerted.add(alert.key);
        if (quotaAlerted.size > 100) { quotaAlerted.clear(); quotaAlerted.add(alert.key); }
        log(`[quota-alert] ${alert.label} at ${alert.utilization.toFixed(0)}% (${alert.level})`);
        if (alert.level === "exhausted") {
          // Suppress a lower-threshold warning for the same window — the red
          // message supersedes it.
          quotaAlerted.add(`${alert.field}:warn:${resetWindowKey(alert.resetsAt)}`);
          const text = `🔴 Claude quota exhausted — ${alert.label} bucket at 100%. Sessions will stall until it resets${fmtResetIn(alert.resetsAt)}. I'll message you when it's back.`;
          // The cap usually lands mid-task, so offer to schedule "Continue
          // working" into whatever was running, for the moment it resets.
          // Each owner gets their own picker (selection state is per message).
          for (const owner of allowedIds) {
            // A failure building the picker must never cost you the alert itself
            // — that's the message this whole feature exists to deliver.
            let offer: ReturnType<typeof buildContinueOffer>;
            try {
              const memberChats = new Set<number>();
              for (const cId of distinctProjectChatIds(configDir)) {
                if (await isChatMember(bot.api, cId, owner)) memberChats.add(cId);
              }
              offer = buildContinueOffer(pm, alert.resetsAt, Date.now(), configDir, (c) => memberChats.has(c));
            } catch (err) {
              logError("[quota-alert] building the continue picker failed — sending a plain alert:", err);
            }
            await bot.api.sendMessage(owner, offer ? `${text}\n\nPick up where you left off?` : text, {
              reply_markup: offer ? { inline_keyboard: offer.keyboard } : undefined,
            }).catch(() => {});
          }
          scheduleResetNotice(alert.field, alert.resetsAt);
        } else {
          await notifyOwners(
            `⚠️ Claude quota: ${alert.label} bucket at ${alert.utilization.toFixed(0)}%${fmtResetIn(alert.resetsAt)}. Sessions may stall when it reaches 100%.`,
          );
        }
      }
    } catch { /* transient — next tick retries */ }
  };
  if (quotaPct > 0) {
    setTimeout(checkQuota, 60_000).unref();          // first check shortly after boot
    setInterval(checkQuota, 10 * 60_000).unref();    // then every 10 minutes
  }

  // Watchdog: exit if Grammy polling stopped (zombie after sleep)
  const healthCheck = setInterval(() => {
    if (!bot.isRunning()) {
      log("[watchdog] Grammy polling stopped — exiting for restart");
      pm.killAll();
      process.exit(1);
    }
  }, HEALTH_CHECK_INTERVAL);
  healthCheck.unref();

  const shutdown = () => {
    log("Shutting down...");
    clearInterval(healthCheck);
    for (const t of bootSpawnTimers) clearTimeout(t);
    pm.killAll();
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
