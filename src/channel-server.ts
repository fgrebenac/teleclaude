#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "http";
import { readFileSync, unlinkSync } from "fs";
import { basename } from "path";
import { z } from "zod";
import { markdownToTelegramHtml, escapeHtml, stripMarkdown, splitText, MAX_MSG_LEN, HTML_SAFE_LEN } from "./telegram-format.js";
import { TurnView, makeFingerprint, type LiveViewMode } from "./turn-view.js";
import { REPLY_REMINDER } from "./channel-instructions.js";
import { formatToolActivity } from "./tool-activity.js";
import { activityRenderDelayMs } from "./activity-render.js";
import { ReplyDelivery } from "./reply-delivery.js";
import { imageContent, type ImageContentBlock } from "./image-content.js";
import { PermissionRelay, type PendingPermission } from "./permission-relay.js";
import { AskRelay, type AskAnswer, type AskQuestionInput, type PendingAsk } from "./ask-relay.js";
import { resolveWithinRoot } from "./path-containment.js";
import { postAuthDecision, readyAuthDecision } from "./http-auth.js";
import { DeliveryDedupe } from "./delivery-dedupe.js";
import {
  androidShape, askUserShape, browseShape, iosShape, replyShape, screenshotShape, sendFileShape, sendPageShape,
} from "./tool-schemas.js";
import { renderPageHtml, slugifyPageTitle } from "./page-render.js";
import { withOneRetry } from "./retry.js";
import { TelegramApiError, classifyTelegramError } from "./telegram-errors.js";

const PORT = Number(process.env.TELECLAUDE_PORT ?? "8801");
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TOPIC_ID = Number(process.env.TELECLAUDE_TOPIC_ID ?? "0");
const CHAT_ID = process.env.TELECLAUDE_CHAT_ID ?? "";
const CALLBACK_URL = process.env.TELECLAUDE_CALLBACK_URL ?? "";
const AUTH_TOKEN = process.env.TELECLAUDE_AUTH_TOKEN ?? "";
const PROJECT_ROOT = process.env.TELECLAUDE_PROJECT_PATH ?? "";
// No dedicated project-name env exists (checked: only TELECLAUDE_PROJECT_PATH
// is passed by processes.ts). send_page reads no files, so unlike PROJECT_ROOT
// it must never fail closed on a missing root — fall back to a fixed label.
const PROJECT_NAME = PROJECT_ROOT ? basename(PROJECT_ROOT) : "teleclaude";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- Telegram helpers ---

// ask_user is exempted from the generic stuck-tool watchdog (it's designed to
// block for minutes waiting on a human) — which means a hang in ANY of its
// Telegram calls now has no safety net at all unless bounded here. 20s is
// generous for one API call under normal conditions but finite.
const TELEGRAM_CALL_TIMEOUT_MS = 20_000;
// Uploads (photo/document) are bigger payloads than a JSON post — give them
// more room before we give up and classify the failure as network/other.
const TELEGRAM_UPLOAD_TIMEOUT_MS = 60_000;

async function telegramPost(method: string, body: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  let json: { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
  try {
    res = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_CALL_TIMEOUT_MS),
    });
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new TelegramApiError(method, err instanceof Error ? err.message : String(err), 0);
  }
  if (!json.ok) {
    throw new TelegramApiError(method, json.description ?? `HTTP ${res.status}`, res.status, json.parameters?.retry_after);
  }
  return json.result;
}

async function sendPhoto(filePath: string): Promise<number> {
  const fileData = readFileSync(filePath);
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("message_thread_id", String(TOPIC_ID));
  form.append("photo", new Blob([fileData]), "screenshot.png");
  let res: Response;
  let json: { ok: boolean; result?: { message_id: number }; description?: string };
  try {
    res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_UPLOAD_TIMEOUT_MS),
    });
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new TelegramApiError("sendPhoto", err instanceof Error ? err.message : String(err), 0);
  }
  if (!json.ok) throw new TelegramApiError("sendPhoto", json.description ?? "failed", res.status);
  return json.result!.message_id;
}

async function sendDocument(fileName: string, data: Buffer | string): Promise<number> {
  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("message_thread_id", String(TOPIC_ID));
  // Cast needed: @types/node's Buffer<ArrayBufferLike> doesn't structurally
  // satisfy BlobPart (which wants ArrayBufferView<ArrayBuffer>) even though a
  // Buffer at runtime is one — a known TS/node types friction, not a real
  // type hazard here (same pattern sendPhoto above uses with a Buffer alone,
  // where inference happens to paper over it).
  form.append("document", new Blob([data as BlobPart]), fileName);

  let res: Response;
  let json: { ok: boolean; result?: { message_id: number }; description?: string };
  try {
    res = await fetch(`${TELEGRAM_API}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TELEGRAM_UPLOAD_TIMEOUT_MS),
    });
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new TelegramApiError("sendDocument", err instanceof Error ? err.message : String(err), 0);
  }
  if (!json.ok) throw new TelegramApiError("sendDocument", json.description ?? "failed", res.status);
  return json.result!.message_id;
}

async function sendFile(filePath: string): Promise<number> {
  // The whole security boundary for this pre-approved tool — see
  // path-containment.ts. Throwing is safe: the tool handler wraps this in
  // runTool(), which converts it to an isError result naming the tool.
  const contained = resolveWithinRoot(PROJECT_ROOT, filePath);
  if (!contained.ok) throw new Error(contained.reason);
  // Accepted TOCTOU: contained.path could be swapped (e.g. re-symlinked)
  // between the resolveWithinRoot check above and this read. Not treated as
  // a real gap here — the threat model this guards against is prompt
  // injection reaching an already-approved tool, and an attacker who can
  // race a symlink swap already has a shell on this host.
  const fileData = readFileSync(contained.path);
  return sendDocument(basename(contained.path), fileData);
}

// --- Turn view: phase-based history + narration/agents (see turn-view.ts) ---

const ACTIVITY_QUEUE_MAX = 5;
const state = new TurnView(ACTIVITY_QUEUE_MAX);
const delivery = new ReplyDelivery(state, {
  send: (text, extra) => sendLong(text, { disable_notification: true, ...extra }),
  edit: (messageId, text) => editFormatted(messageId, text),
});

// Live-view mode: "full" (everything, always live), "summary" (collapse to
// renderFinal("summary") at turn end), "off" (same detailed-render path as
// "full" at turn end — no summary collapse — with narration additionally
// gated off; tool outcomes and agent rows still render). Set at spawn via
// env, mutable at runtime via POST /live-mode.
const LIVE_VIEW_MODES = new Set<LiveViewMode>(["full", "summary", "off"]);
function parseLiveMode(v: string | undefined): LiveViewMode {
  return v !== undefined && LIVE_VIEW_MODES.has(v as LiveViewMode) ? (v as LiveViewMode) : "summary";
}
let liveMode: LiveViewMode = parseLiveMode(process.env.TELECLAUDE_LIVE_VIEW);
// "off" keeps classic uncollapsed phase rendering (its documented "old
// behavior" contract); "full"/"summary" collapse each CLOSED phase to a
// one-line ▸ summary — see the LiveViewMode/phaseCollapse doc in turn-view.ts.
state.phaseCollapse = liveMode !== "off";

// --- Callback to orchestrator ---

const REPLY_CALLBACK_TIMEOUT_MS = 10_000;
const REPLY_CALLBACK_RETRY_DELAY_MS = 2_000;

function notifyReply(replyText: string): void {
  if (!CALLBACK_URL) return;
  const post = () => fetch(CALLBACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "reply",
      message_id: delivery.messageId,
      chat_id: CHAT_ID,
      text: replyText,
    }),
    signal: AbortSignal.timeout(REPLY_CALLBACK_TIMEOUT_MS),
  });
  // Deliberately not awaited by callers — reply delivery to Telegram must
  // never block on the daemon. But a LOST callback leaves the daemon's
  // responseTimeouts armed (false "Claude may be stuck" alert over a turn
  // that answered) and its reply counter at 0 (a spurious /forward duplicate
  // of the reply on `done`), so one bounded retry is worth having.
  // A non-2xx daemon answer is not retried: the daemon answers 200 to every
  // token-valid callback, so a rejection is deterministic, not transient.
  void withOneRetry(post, REPLY_CALLBACK_RETRY_DELAY_MS).catch((err) => {
    process.stderr.write(`[channel:${TOPIC_ID}] reply callback lost after retry: ${err}\n`);
  });
}

// --- Telegram send with HTML fallback and message splitting ---

async function sendFormatted(text: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
  const html = markdownToTelegramHtml(text);
  const post = (t: string, mode?: "HTML") =>
    telegramPost("sendMessage", {
      chat_id: CHAT_ID,
      text: t,
      message_thread_id: TOPIC_ID,
      ...(mode ? { parse_mode: mode } : {}),
      ...extra,
    }) as Promise<{ message_id: number }>;

  // Escaping-heavy content can inflate past the limit: send stripped plain
  // directly (raw chunks are ≤ HTML_SAFE_LEN plus ~30 chars of fence-rebalancing
  // markers, and stripMarkdown never grows text, so this always fits) — no
  // doomed HTML attempt first.
  if (html.length > MAX_MSG_LEN) return post(stripMarkdown(text));

  try {
    return await post(html, "HTML");
  } catch (err) {
    switch (classifyTelegramError(err)) {
      case "rate-limit": {
        // Capped at 10s (not the full 30s Telegram could ask for): this wait
        // is part of forward-fallback.ts's FORWARD_TIMEOUT_MS delivery
        // budget for a /forward call, which assumes this exact cap per chunk.
        const waitS = Math.max(0, Math.min((err as TelegramApiError).retryAfter ?? 3, 10));
        await new Promise((r) => setTimeout(r, waitS * 1000));
        return await post(html, "HTML");
      }
      case "parse":
      case "too-long":
        return await post(stripMarkdown(text));
      default:
        // network/other: the send may have LANDED — a blind plain resend
        // here is a visible duplicate. Propagate instead; the reply tool
        // reports the failure and rollback keeps state consistent.
        throw err;
    }
  }
}

async function editFormatted(messageId: number, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  const edit = (t: string, mode?: "HTML") =>
    telegramPost("editMessageText", {
      chat_id: CHAT_ID,
      message_id: messageId,
      text: t,
      ...(mode ? { parse_mode: mode } : {}),
    });

  if (html.length > MAX_MSG_LEN) { await edit(stripMarkdown(text)); return; }

  try {
    await edit(html, "HTML");
  } catch (err) {
    switch (classifyTelegramError(err)) {
      case "not-modified":
        return; // identical content — success
      case "rate-limit": {
        // Same 10s cap and cross-file coupling as sendFormatted above.
        const waitS = Math.max(0, Math.min((err as TelegramApiError).retryAfter ?? 3, 10));
        await new Promise((r) => setTimeout(r, waitS * 1000));
        await edit(html, "HTML");
        return;
      }
      case "parse":
      case "too-long":
        await edit(stripMarkdown(text));
        return;
      case "network":
        // Edits are idempotent — one retry is safe (unlike sends).
        await edit(html, "HTML");
        return;
      default:
        throw err;
    }
  }
}

/** Send text that may need splitting into multiple messages. */
// At-most-once is guaranteed per CHUNK, not per whole message: a throw from
// sendFormatted mid-loop (e.g. the "network/other" rethrow above) leaves
// earlier chunks already delivered, and ReplyDelivery's rollback + a caller
// retry can resend/duplicate them. Accepted over the alternative of catching
// here and blind-resending the whole text, which is strictly worse (turns a
// possible partial duplicate into a guaranteed full one).
async function sendLong(text: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
  const chunks = splitText(text);
  let lastResult: { message_id: number } = { message_id: 0 };
  for (const chunk of chunks) {
    lastResult = await sendFormatted(chunk, extra);
  }
  return lastResult;
}

/**
 * Deliver a reply to Telegram: close the current phase, edit in place when
 * possible, otherwise send a new message. Rolls back state on send failure.
 * notify=false skips the orchestrator callback (used by /forward, where the
 * orchestrator is the caller).
 */
async function deliverReply(text: string, notify = true): Promise<void> {
  // Cancel any pending activity render — deliverReply renders the full state
  // itself; a stale timer firing mid-send could post a duplicate message.
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  await delivery.deliver(text);
  if (notify) notifyReply(text);
}

// Latched true once a "summary"-mode turn has actually collapsed to its
// terminal form. While latched: scheduleActivityRender is a no-op (nothing
// may re-expand the collapsed message back to a live view) and the
// single-flight guard's dirty-recovery re-runs the COLLAPSE render instead
// of the activity render (see runSerializedRender below). Cleared on a new
// inbound message, next to turnStarted — a fresh turn always starts live.
let collapsed = false;

// Single-flight render guard: renderActivity and the /done final edit(s)
// both end up as a Telegram edit against the SAME message id. Without this,
// a slow edit (renderActivity) could still be in flight when a faster one
// (the /done final edit) lands, and the earlier request's response could
// then arrive second — an older render clobbering a newer one. One in-flight
// edit at a time; a request that arrives while busy only marks `dirty` and
// re-renders once the in-flight edit settles, so the LATEST state always
// wins the last word. While `collapsed` is latched, "the latest state" means
// the collapse render, not the live activity render — otherwise a dirty
// activity render coalesced during the collapse edit would re-expand the
// just-collapsed message the moment it settles.
let renderInFlight = false;
let renderDirty = false;
async function runSerializedRender(fn: () => Promise<void>): Promise<void> {
  if (renderInFlight) { renderDirty = true; return; }
  renderInFlight = true;
  try { await fn(); } finally {
    renderInFlight = false;
    if (renderDirty) {
      renderDirty = false;
      if (collapsed) void collapseToSummary(Date.now());
      else scheduleActivityRender();
    }
  }
}

// Coalesce activity renders — rapid tool events would otherwise hit
// Telegram's edit rate limit (swallowed 429s = stale display).
const RENDER_COALESCE_MS = 1000;
// The first activity render of a turn uses this shorter delay so a turn that
// opens with silent tool work shows activity almost at once, instead of after a
// full RENDER_COALESCE_MS of dead air. Kept non-zero so a tight burst of opening
// tool events still coalesces into one send, and still routed through the timer
// (not an immediate dispatch) so deliverReply and /done can cancel it — the
// invariant the rest of the render/collapse lifecycle depends on.
const FIRST_ACTIVITY_RENDER_MS = 150;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleActivityRender(): void {
  const delay = activityRenderDelayMs(
    collapsed,
    delivery.messageId !== null,
    FIRST_ACTIVITY_RENDER_MS,
    RENDER_COALESCE_MS,
  );
  if (delay === null) return; // turn already collapsed to its summary — no more live updates
  if (renderTimer) return; // a render is already pending — coalesce onto it
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void runSerializedRender(() => delivery.renderActivity({ disable_notification: true }));
  }, delay);
}

// --- Turn-end collapse ("summary" live-view mode) --------------------------

// Set only while a background agent is holding shouldCollapse() back — fires
// once, 10 minutes after the turn's own /done, to re-check and (normally)
// collapse anyway. Cleared on an actual collapse (implicit: it only ever
// fires once) and on a new inbound message (a fresh turn starting makes any
// pending collapse-of-the-PREVIOUS-turn moot).
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
const COLLAPSE_RECHECK_MS = 10 * 60_000;

function clearCollapseTimer(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
}

/**
 * Collapse the live message to its "summary" terminal form. Known accepted
 * caveat: if delivery.deliver() rolled back via state.restore() earlier this
 * turn (a failed-send retry mid-turn), the restored phase's tool header is
 * folded into replyText with no separate header (see turn-view.ts's Phase
 * interface doc) — this renderFinal("summary") call would then include that
 * header text too. Rollback is rare; accepted, not redesigned here.
 */
async function collapseToSummary(now: number): Promise<void> {
  // Cancel any earlier /done's still-armed 10-minute recheck: without this,
  // an immediate collapse here (e.g. the background agent that blocked the
  // FIRST /done has since stopped) leaves that timer to fire later anyway,
  // re-editing with a receipt duration recomputed at fire time — a stale
  // "⏱ 10m 32s" on what was really a 30-second turn. Idempotent when there's
  // nothing to clear (e.g. called again from the dirty-recovery path above).
  clearCollapseTimer();
  const msgId = delivery.messageId;
  if (msgId === null) return;
  const msg = state.renderFinal("summary", now);
  // Same guard the pre-existing full/off final edit already applies:
  // renderFinal("summary") bypasses TurnView's own render() budget (it's
  // built straight from phase text, not applyBudget()), so it can still
  // exceed Telegram's safe edit length. Skip the edit rather than silently
  // degrading to stripped plain text — leave the live (pre-collapse) view as
  // the frozen final state instead. Deliberately NOT latched `collapsed` in
  // this branch: the turn never actually collapsed, so live updates (if any
  // still arrive) must keep being allowed to render.
  if (msg.length > HTML_SAFE_LEN) return;
  // Latch BEFORE the async edit (not after it resolves): a tool/narration/
  // subagent event landing while the edit is still in flight must be
  // silently ignored (scheduleActivityRender consults this same flag), not
  // race the edit that's about to declare the turn finished.
  collapsed = true;
  await runSerializedRender(async () => {
    await editFormatted(msgId, msg).catch(() => {});
  });
}

// ONE re-check per turn-end, not a repeating loop: if a LATER /done bumped
// noteDone's timestamp again while this was pending (another turn ended
// while this one's background agent was still running), the single firing
// below can find shouldCollapse still false and simply does nothing further
// — the next /done call schedules its own fresh recheck instead of this one
// chaining itself. In the ordinary case (no further /done), the elapsed-time
// term in shouldCollapse's own condition is false by construction at the
// 10-minute mark, so this always collapses then regardless of agent state.
function scheduleCollapseRecheck(): void {
  if (collapseTimer) return; // one outstanding recheck is enough
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    // The mode can have been switched away from "summary" (/live full or
    // /live off) while this recheck was pending — collapsing would then be
    // wrong for the mode the topic is actually in now.
    if (liveMode !== "summary") return;
    const now = Date.now();
    if (state.shouldCollapse(now)) void collapseToSummary(now);
  }, COLLAPSE_RECHECK_MS);
}

// --- MCP Server ---

const mcp = new McpServer(
  { name: "teleclaude", version: "2.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
    instructions: [
      'Messages from Telegram arrive as <channel source="teleclaude" sender="...">.',
      "Reply with the reply tool. Use send_file to send files back.",
      "The sender reads Telegram, not this session — anything you want them to see must go through the reply tool.",
      "Keep messages concise — the user is on their phone. Use standard markdown formatting (bold, code, etc.) — it will be converted automatically.",
      "For reports, tables, or long structured answers, send_page turns markdown into a styled HTML document the user opens in Telegram.",
      "",
      "PROGRESS: Call reply before slow operations (Bash commands, web fetches, file writes) and after finding key information. The user cannot see your tool calls — they need running commentary: 'Checking test results...', 'Found the bug on line 42, fixing now...', 'Running tsc — 3 errors to fix...'. Replies edit in-place; frequent short updates don't spam the user.",
      "",
      "SYSTEM REMINDERS: Messages with sender=system are silent context injections. Internalize them and do not reply — not even to acknowledge. Continue working as if the reminder was always part of your context.",
      "",
      "SCHEDULING: You can schedule recurring tasks using CronCreate. When the user asks to schedule something (e.g. 'run tests every morning at 8am'), create a durable cron job. Use reply to confirm what was scheduled. Durable crons persist across session restarts.",
      "",
      "QUESTIONS: This session has no interactive terminal. Never call the built-in AskUserQuestion tool — its picker can't render here and the call will just be denied. Use this server's ask_user tool instead: same shape (questions/options/multiSelect), but it relays to real Telegram buttons and returns the user's actual answer.",
    ].join("\n"),
  },
);

type ContentBlock = { type: "text"; text: string } | ImageContentBlock;

/**
 * Send every screenshot to the Telegram topic (the user's copy), and when
 * return_image is set also hand the *final* one back to Claude as an image
 * block. Only the last one: it's the state that matters, and each extra image
 * multiplies the context cost. Files are deleted after both copies are made.
 */
async function deliverScreenshots(
  paths: string[],
  returnImage: boolean,
): Promise<{ blocks: ContentBlock[]; note: string }> {
  const blocks: ContentBlock[] = [];
  let note = "";
  try {
    for (let i = 0; i < paths.length; i++) {
      const filePath = paths[i];
      await sendPhoto(filePath);
      if (returnImage && i === paths.length - 1) {
        const res = await imageContent(filePath);
        if (res.block) {
          blocks.push(res.block);
          process.stderr.write(`[channel:${TOPIC_ID}] inlined screenshot ${Math.round(res.bytes / 1024)}KB\n`);
        } else {
          // Tell Claude why it can't see the image, so it doesn't act as if it can.
          note = ` (image not returned to you: ${res.reason})`;
          process.stderr.write(`[channel:${TOPIC_ID}] image not inlined: ${res.reason}\n`);
        }
      }
    }
  } finally {
    // Clean up every path, not just the ones we got to: a failed sendPhoto
    // throws out of the loop, and screenshots are 200KB-1.5MB each in /tmp.
    for (const filePath of paths) {
      try { unlinkSync(filePath); } catch { /* already gone */ }
    }
  }
  return { blocks, note };
}

type ToolResult = { content: ContentBlock[]; isError?: boolean };

/**
 * Preserve the previous error contract: a throw becomes an isError result naming
 * the tool, never an exception out of the handler. A tool that kills this process
 * takes the whole Telegram topic down with it.
 */
async function runTool(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[channel:${TOPIC_ID}] ${name} failed: ${msg}\n`);
    return { content: [{ type: "text", text: `${name} failed: ${msg}` }], isError: true };
  }
}

mcp.registerTool("reply", {
  description: "Send a text message back to the Telegram topic.",
  inputSchema: replyShape,
  // Claude Code defers MCP tool schemas behind ToolSearch by default. reply is
  // needed on literally every turn — without this Claude burns a search
  // round-trip (observed: two ToolSearch calls, ~9s, before every reply) just to
  // find the tool the whole bridge depends on. Per-tool rather than the
  // server-wide `alwaysLoad` config flag, so the big android/ios/browse schemas
  // stay deferred and out of context.
  _meta: { "anthropic/alwaysLoad": true },
}, async ({ text, message }) => runTool("reply", async () => {
  const body = text ?? message ?? "";
  if (!body.trim()) {
    return { content: [{ type: "text", text: "error: reply requires non-empty 'text'" }], isError: true };
  }
  process.stderr.write(`[channel:${TOPIC_ID}] reply tool: text=${body.slice(0, 80)} phases=${state.phaseCount} tools=${state.toolCount} lastMsgId=${delivery.messageId}\n`);
  await deliverReply(body);
  return { content: [{ type: "text", text: "sent" }] };
}));

mcp.registerTool("send_file", {
  description: "Send a file from the project directory to the Telegram topic. Only files inside the project directory can be sent (symlinks are resolved; max 50MB).",
  inputSchema: sendFileShape,
  _meta: { "anthropic/alwaysLoad": true },
}, async ({ file_path }) => runTool("send_file", async () => {
  const msgId = await sendFile(file_path);
  return { content: [{ type: "text", text: `sent file (id: ${msgId})` }] };
}));

mcp.registerTool("send_page", {
  description:
    "Render markdown into a polished, self-contained HTML document and send it to the Telegram topic. " +
    "The user opens it in Telegram's in-app browser — ideal for reports, tables, summaries, or any long structured answer. " +
    "Styled automatically (dark-mode aware); inline HTML inside the markdown passes through for special layouts. Content max 2MB. " +
    "The title is already rendered as the page heading — start content with body text, don't repeat it as an H1.",
  inputSchema: sendPageShape,
  // Deliberately NOT alwaysLoad: unlike reply this isn't a per-turn tool, so
  // the schema stays deferred; discoverability comes from the server
  // instructions line instead.
}, async ({ title, content, filename }) => runTool("send_page", async () => {
  const html = renderPageHtml(content, { title, projectName: PROJECT_NAME });
  if (html === null) {
    throw new Error("content is empty or over 2MB — send a shorter markdown body");
  }
  const msgId = await sendDocument(`${slugifyPageTitle(filename ?? title)}.html`, html);
  return { content: [{ type: "text", text: `sent page (id: ${msgId})` }] };
}));

mcp.registerTool("screenshot", {
  description: "Take a screenshot of a URL and send it to the Telegram topic. Useful for showing the user what a web page looks like (e.g. localhost dev server).",
  inputSchema: screenshotShape,
}, async ({ url, full_page, return_image }) => runTool("screenshot", async () => {
  const { takeScreenshot } = await import("./screenshot.js");
  const filePath = await takeScreenshot({ url, fullPage: full_page ?? false });
  const { blocks, note } = await deliverScreenshots([filePath], return_image === true);
  return { content: [{ type: "text", text: `screenshot sent${note}` }, ...blocks] };
}));

mcp.registerTool("browse", {
  description: "Interact with a web page: navigate, click, type, scroll, then screenshot. Actions execute in sequence. Always takes a final screenshot even if not explicitly requested.",
  inputSchema: browseShape,
}, async ({ actions, return_image }) => runTool("browse", async () => {
  const { browse: doBrowse } = await import("./screenshot.js");
  const result = await doBrowse(actions);
  const { blocks, note } = await deliverScreenshots(result.screenshots, return_image === true);
  return { content: [{ type: "text", text: `Done. ${result.log.join(" → ")}${note}` }, ...blocks] };
}));

mcp.registerTool("android", {
  description: "Control a local Android emulator: launch headless, install APKs, interact (tap/swipe/type), open URLs, take screenshots. Returns screenshots sent to Telegram. Requires Android SDK installed (see README).",
  inputSchema: androidShape,
}, async ({ actions, serial, return_image }) => runTool("android", async () => {
  const { androidAction } = await import("./android.js");
  const result = await androidAction(actions, serial);
  const { blocks, note } = await deliverScreenshots(result.screenshots, return_image === true);
  return { content: [{ type: "text", text: `Done. ${result.log.join(" → ")}${note}` }, ...blocks] };
}));

mcp.registerTool("ios", {
  description: "Control a local iOS simulator: boot headless, install IPAs, interact (tap/swipe/type), open URLs, take screenshots. Returns screenshots sent to Telegram. Requires Xcode + idb installed (see README).",
  inputSchema: iosShape,
}, async ({ actions, udid, return_image }) => runTool("ios", async () => {
  const { iosAction } = await import("./ios.js");
  const result = await iosAction(actions, udid);
  const { blocks, note } = await deliverScreenshots(result.screenshots, return_image === true);
  return { content: [{ type: "text", text: `Done. ${result.log.join(" → ")}${note}` }, ...blocks] };
}));

// --- ask_user: relay AskUserQuestion-shaped prompts to Telegram buttons ---
//
// Claude Code's own AskUserQuestion has no non-interactive answer channel (see
// the PreToolUse fallback in daemon.ts), so this is our own blocking tool: the
// handler awaits AskRelay.ask() directly, and the wait is satisfied entirely
// by the HTTP handling below — a button tap, a submit, a cancel, a ForceReply
// answer, or the relay's own timeout.

const ASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, matching the permission-prompt relay
const ASK_OPTION_DESC_MAX = 300;
const ASK_BUTTON_LABEL_MAX = 60;

/** Clip by UTF-16 code point, not byte — avoids splitting a surrogate pair (emoji) mid-character. */
function clipCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function randomAskId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// These build raw Telegram HTML directly, deliberately bypassing
// markdownToTelegramHtml: that pipeline HTML-escapes its *entire* input before
// applying markdown substitutions (so a literal "<b>" would come out as the
// visible text "&lt;b&gt;"), which is exactly right for reply-tool text
// (markdown authored by Claude) but wrong here — every function below either
// produces a `*Html` (parse_mode HTML, sent as-is) or `*Plain` (no formatting,
// used only if the HTML send/edit is rejected) version, mirroring how
// permission-relay's prompts are sent.

function questionHeaderHtml(question: AskQuestionInput, index: number, total: number): string {
  const progress = total > 1 ? `<i>Question ${index + 1} of ${total}</i>\n` : "";
  const headerLine = question.header ? `❓ <b>${escapeHtml(question.header)}</b>\n` : "❓ ";
  return `${progress}${headerLine}${escapeHtml(question.question)}`;
}

function questionHeaderPlain(question: AskQuestionInput, index: number, total: number): string {
  const progress = total > 1 ? `Question ${index + 1} of ${total}\n` : "";
  const headerLine = question.header ? `❓ ${question.header}\n` : "❓ ";
  return `${progress}${headerLine}${question.question}`;
}

function buildAskHtml(question: AskQuestionInput, index: number, total: number): string {
  const optionLines = question.options.map((o, i) => {
    const desc = o.description ? ` — ${escapeHtml(clip(o.description, ASK_OPTION_DESC_MAX))}` : "";
    return `${i + 1}. <b>${escapeHtml(o.label)}</b>${desc}`;
  }).join("\n");
  return `${questionHeaderHtml(question, index, total)}\n\n${optionLines}`;
}

function buildAskPlain(question: AskQuestionInput, index: number, total: number): string {
  const optionLines = question.options.map((o, i) => {
    const desc = o.description ? ` — ${clip(o.description, ASK_OPTION_DESC_MAX)}` : "";
    return `${i + 1}. ${o.label}${desc}`;
  }).join("\n");
  return `${questionHeaderPlain(question, index, total)}\n\n${optionLines}`;
}

function buildAskKeyboard(pending: Pick<PendingAsk, "requestId" | "question" | "selected">): { text: string; callback_data: string }[][] {
  const { requestId, question, selected } = pending;
  const rows = question.options.map((option, i) => {
    const checked = question.multiSelect ? (selected.includes(i) ? "✅ " : "⬜ ") : `${i + 1}. `;
    const verb = question.multiSelect ? "toggle" : "pick";
    return [{
      text: clipCodePoints(`${checked}${option.label}`, ASK_BUTTON_LABEL_MAX),
      callback_data: `ask:${verb}:${requestId}:${i}`,
    }];
  });
  if (question.multiSelect) rows.push([{ text: "✅ Submit", callback_data: `ask:submit:${requestId}` }]);
  rows.push([
    { text: "✏️ Write my own answer", callback_data: `ask:custom:${requestId}` },
    { text: "❌ Cancel", callback_data: `ask:cancel:${requestId}` },
  ]);
  return rows;
}

/** Send a prompt (question) with an HTML→plain fallback, mirroring permission-relay's pattern. */
async function sendAskPrompt(html: string, plain: string, extra: Record<string, unknown>): Promise<number> {
  try {
    const sent = (await telegramPost("sendMessage", {
      chat_id: CHAT_ID, message_thread_id: TOPIC_ID, text: html, parse_mode: "HTML", ...extra,
    })) as { message_id: number };
    return sent.message_id;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[channel:${TOPIC_ID}] ask_user prompt HTML send failed (${reason}) — retrying as plain text\n`);
    const sent = (await telegramPost("sendMessage", {
      chat_id: CHAT_ID, message_thread_id: TOPIC_ID, text: plain, ...extra,
    })) as { message_id: number };
    return sent.message_id;
  }
}

/**
 * Send exactly once, no HTML attempt and no retry-as-plain fallback — unlike
 * `sendAskPrompt`, whose fallback-on-any-error could in rare cases (Telegram
 * accepted the send, but the response was lost) double-send. Fine for the
 * initial question — a stray duplicate there is just an extra, eventually-
 * timed-out set of buttons — but the ForceReply prompt's message *id* is load
 * -bearing: `matchCustomReply` keys on it, so a duplicate send would silently
 * orphan whichever copy the retry didn't register.
 */
async function sendPlainOnce(text: string, extra: Record<string, unknown>): Promise<number> {
  const sent = (await telegramPost("sendMessage", {
    chat_id: CHAT_ID, message_thread_id: TOPIC_ID, text, ...extra,
  })) as { message_id: number };
  return sent.message_id;
}

/** Edit a resolved prompt's message: clear its keyboard and show what was decided. */
async function retireAskMessage(messageId: number, html: string, plain: string): Promise<void> {
  try {
    await telegramPost("editMessageText", {
      chat_id: CHAT_ID, message_id: messageId, text: html, parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  } catch {
    await telegramPost("editMessageText", {
      chat_id: CHAT_ID, message_id: messageId, text: plain,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
}

function resolutionHtml(answer: AskAnswer): string {
  switch (answer.kind) {
    case "picked": return `✅ <b>${escapeHtml(answer.labels.join(", "))}</b>`;
    case "custom": return `✏️ ${escapeHtml(clip(answer.text, ASK_OPTION_DESC_MAX))}`;
    case "cancelled": return "❌ Skipped";
    case "timeout": return "⏱ No answer within 5 minutes — continuing without one.";
    case "superseded": return "↩️ Superseded by a newer question.";
  }
}

function resolutionPlain(answer: AskAnswer): string {
  switch (answer.kind) {
    case "picked": return `✅ ${answer.labels.join(", ")}`;
    case "custom": return `✏️ ${clip(answer.text, ASK_OPTION_DESC_MAX)}`;
    case "cancelled": return "❌ Skipped";
    case "timeout": return "⏱ No answer within 5 minutes — continuing without one.";
    case "superseded": return "↩️ Superseded by a newer question.";
  }
}

function formatAnswerForClaude(question: AskQuestionInput, answer: AskAnswer): string {
  const q = question.question;
  switch (answer.kind) {
    case "picked": return `Q: "${q}" → ${answer.labels.join(", ")}`;
    case "custom": return `Q: "${q}" → [custom answer] ${answer.text}`;
    case "cancelled": return `Q: "${q}" → [user skipped this question]`;
    case "timeout": return `Q: "${q}" → [no answer within 5 minutes — proceed using your best judgement, or ask again later]`;
    case "superseded": return `Q: "${q}" → [superseded before it was answered]`;
  }
}

// At-least-once inbound delivery — see delivery-dedupe.ts for why this lives
// (and dies) with this process.
const deliveryDedupe = new DeliveryDedupe();

// Reply-tool reminder: prepended only on the first message this process injects.
// Flag flips before the await so a concurrent retry can't double-prepend. Accepted
// trade-off: if first injection fails, the flag is still flipped, so a daemon retry
// arrives without the reminder — worst case one session's reminder never landed, but
// that session is still covered by the MCP server instructions and the /forward fallback.
let firstInjectionDone = false;

const askRelay = new AskRelay({
  timeoutMs: ASK_TIMEOUT_MS,
  onTimeout: (p) => {
    process.stderr.write(`[channel:${TOPIC_ID}] ask_user timeout — requestId=${p.requestId}\n`);
    // The *original question* message is deliberately left alone here — the
    // tool handler's own `await ask(...)` continuation below retires it for
    // every resolution kind including timeout, with better context (the
    // "question i of n" progress line), and a second edit here would race it.
    // But if "write my own answer" was tapped and never answered, that
    // ForceReply prompt is a SEPARATE message the tool handler has no way to
    // reach (it only knows the original question's message id) — left alone
    // it would sit there forever still visually asking for a reply.
    if (p.customPromptMessageId !== null) {
      const notice = "This question timed out after 5 minutes without an answer.";
      retireAskMessage(p.customPromptMessageId, notice, notice).catch(() => {});
    }
  },
});

mcp.registerTool("ask_user", {
  description: "Ask the user one or more multiple-choice questions via Telegram buttons. Prefer this over the built-in AskUserQuestion tool in this session — it's Telegram-hosted with no interactive terminal, so AskUserQuestion's picker never renders and the call just hangs. Blocks until the user answers (button tap, typed custom answer, or cancel), or a 5-minute timeout elapses.",
  inputSchema: askUserShape,
}, async ({ questions }) => runTool("ask_user", async () => {
  const qs = questions as AskQuestionInput[];
  const answers: string[] = [];
  for (let i = 0; i < qs.length; i++) {
    const question = qs[i];
    const requestId = randomAskId();
    const promise = askRelay.ask(requestId, question);
    // Bring the live message up to date before the question goes out below
    // it — it's frozen right after (see delivery.detach() below).
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    await runSerializedRender(() => delivery.renderActivity({ disable_notification: true }));
    let messageId: number | null = null;
    try {
      messageId = await sendAskPrompt(
        buildAskHtml(question, i, qs.length),
        buildAskPlain(question, i, qs.length),
        { reply_markup: { inline_keyboard: buildAskKeyboard({ requestId, question, selected: [] }) } },
      );
      askRelay.setMessageId(requestId, messageId);
      // Everything after the answer continues in a new message below the
      // question — editing the one above it would update out of view.
      delivery.detach();
    } catch (err) {
      process.stderr.write(`[channel:${TOPIC_ID}] ask_user prompt undeliverable: ${err instanceof Error ? err.message : String(err)} — will auto-resolve via timeout\n`);
    }
    const answer = await promise;
    if (messageId !== null) {
      await retireAskMessage(
        messageId,
        `${questionHeaderHtml(question, i, qs.length)}\n\n${resolutionHtml(answer)}`,
        `${questionHeaderPlain(question, i, qs.length)}\n\n${resolutionPlain(answer)}`,
      ).catch(() => {});
    }
    answers.push(formatAnswerForClaude(question, answer));
  }
  return { content: [{ type: "text", text: answers.join("\n") }] };
}));

// --- Permission relay: forward approval prompts to Telegram ---

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Retire a closed prompt's Telegram message so nobody taps a dead button. */
async function retirePrompt(p: PendingPermission, label: string): Promise<void> {
  if (p.messageId === null) return;
  await telegramPost("editMessageReplyMarkup", {
    chat_id: CHAT_ID,
    message_id: p.messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => { /* message gone or already edited */ });
  await telegramPost("sendMessage", {
    chat_id: CHAT_ID,
    message_thread_id: TOPIC_ID,
    reply_to_message_id: p.messageId,
    text: label,
    disable_notification: true,
  }).catch(() => { /* best effort */ });
}

const permissions = new PermissionRelay({
  timeoutMs: PERMISSION_TIMEOUT_MS,
  onTimeout: async (p) => {
    process.stderr.write(`[channel:${TOPIC_ID}] permission timeout — auto-denying request_id=${p.requestId} tool=${p.toolName} assumedAnswered=${p.assumedAnswered}\n`);
    await mcp.server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: p.requestId, behavior: "deny" },
    }).catch(() => {});
    // A prompt whose tool has already completed was answered at the terminal:
    // the deny above is dropped by Claude Code as stale, and telling Claude the
    // call was denied would be false context about work that succeeded.
    if (p.assumedAnswered) {
      process.stderr.write(`[channel:${TOPIC_ID}] suppressed timeout notice for ${p.requestId} — ${p.toolName} already ran or the turn ended\n`);
      if (!p.promptRetired) await retirePrompt(p, "⏱ This prompt is closed.");
      return;
    }
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: `[No answer to the Telegram permission prompt for ${p.toolName} within 5 minutes, so a deny was sent. Ask the user before retrying.]`,
        meta: { sender: "system" },
      },
    }).catch(() => {});
    await retirePrompt(p, "⏱ Permission prompt expired — denied.");
  },
});

/**
 * Budget for the relayed fields. Claude Code relays up to 3,500 code points per
 * field, so description + input_preview can blow past Telegram's 4096 on their
 * own — before escaping inflates every `&` to `&amp;`. Truncate to fit rather
 * than let sendMessage fail: a rejected send means the prompt never arrives.
 */
const PERM_DESC_MAX = 600;
const PERM_PREVIEW_MAX = 1200;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

mcp.server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Register BEFORE attempting the send. If Telegram rejects or is unreachable,
  // the local dialog is still open in a PTY nobody is watching — without a
  // pending entry and timer, that turn would hang indefinitely.
  permissions.add(params.request_id, params.tool_name);

  // Escape every relayed field: these are model-authored / tool-argument text
  // (the docs say to treat them as untrusted), and a bare `<` or `&` makes
  // Telegram reject the whole HTML message — the prompt would never arrive and
  // the session would hang until the auto-deny above.
  const previewText = clip(params.input_preview, PERM_PREVIEW_MAX);
  const preview = previewText ? `\n\n<pre>${escapeHtml(previewText)}</pre>` : "";
  const msg = `🔐 <b>${escapeHtml(params.tool_name)}</b>\n\n${escapeHtml(clip(params.description, PERM_DESC_MAX))}${preview}`;
  const body = {
    chat_id: CHAT_ID,
    message_thread_id: TOPIC_ID,
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Allow", callback_data: `perm:yes:${params.request_id}` },
        { text: "❌ Deny", callback_data: `perm:no:${params.request_id}` },
      ]],
    },
  };
  try {
    const sent = (await telegramPost("sendMessage", { ...body, text: msg, parse_mode: "HTML" })) as { message_id: number };
    permissions.setMessageId(params.request_id, sent.message_id);
  } catch (err) {
    // Last resort: buttons without formatting. Better a plain prompt than none.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[channel:${TOPIC_ID}] permission prompt HTML send failed (${reason}) — retrying as plain text\n`);
    try {
      const sent = (await telegramPost("sendMessage", {
        ...body,
        text: `🔐 ${params.tool_name}\n\n${clip(params.description, PERM_DESC_MAX)}\n\n${clip(params.input_preview, PERM_PREVIEW_MAX)}`,
      })) as { message_id: number };
      permissions.setMessageId(params.request_id, sent.message_id);
    } catch (err2) {
      const reason2 = err2 instanceof Error ? err2.message : String(err2);
      process.stderr.write(`[channel:${TOPIC_ID}] permission prompt undeliverable: ${reason2} — auto-deny in ${PERMISSION_TIMEOUT_MS / 1000}s\n`);
    }
  }
});

// Handle permission verdicts from inbound messages: "yes <id>" / "no <id>".
// The documented id is 5 lowercase letters from a-z minus 'l'. We stay a little
// looser than the contract (bounded alphanumeric) so a future id format change
// doesn't silently break relay, but not open-ended: the id must still match a
// PENDING request, and `\S+` would have accepted arbitrary punctuation/Unicode.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-z0-9]{3,12})\s*$/i;

// ask_user button taps arrive as `ask:<verb>:<requestId>[:<optionIndex>]` — a
// format only our own callback handler ever produces (see handlers/index.ts),
// so unlike PERMISSION_REPLY_RE this doesn't need to tolerate anything a human
// might plausibly type.
const ASK_VERDICT_RE = /^ask:(pick|toggle|submit|custom|cancel):([a-z0-9]{4,12})(?::(\d+))?$/;

// --- HTTP listener for inbound messages from orchestrator ---

let mcpReady = false;

// A throw anywhere in the async handler (malformed JSON body, MCP transport
// closing mid-notification) must not become an unhandled rejection — modern
// Node exits on those, killing the MCP server under Claude Code mid-turn.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`[channel:${TOPIC_ID}] unhandledRejection: ${msg}\n`);
});

async function handleHttp(req: import("http").IncomingMessage, res: import("http").ServerResponse): Promise<void> {
  // Readiness check — returns 200 only after MCP is connected, and only to the
  // spawn this server belongs to. Ports are recycled, so a server still shutting
  // down after its Claude Code process died can be asked about a port that now
  // belongs to a *newer* spawn; answering 200 there told the daemon a session
  // was ready to receive when nothing of its own was listening yet. The token is
  // only compared, never echoed — it is this server's HTTP auth secret.
  if (req.method === "GET" && req.url === "/ready") {
    const readyAuth = readyAuthDecision(AUTH_TOKEN, req.headers["x-teleclaude-token"]);
    if (!readyAuth.ok) {
      res.writeHead(readyAuth.status).end(readyAuth.body);
      return;
    }
    if (mcpReady) {
      res.writeHead(200).end("ready");
    } else {
      res.writeHead(503).end("not ready");
    }
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end("Method not allowed");
    return;
  }

  // All POSTs must carry the spawn token — blocks other local processes from
  // injecting messages or permission verdicts. Fails CLOSED: an empty token
  // rejects everything (the old `AUTH_TOKEN &&` short-circuit accepted all).
  const postAuth = postAuthDecision(AUTH_TOKEN, req.headers["x-teleclaude-token"]);
  if (!postAuth.ok) {
    res.writeHead(postAuth.status).end(postAuth.body);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const rawBody = Buffer.concat(chunks).toString();

  process.stderr.write(`[channel:${TOPIC_ID}] HTTP ${req.method} ${req.url} body=${rawBody.slice(0, 120)}\n`);

  // Task progress events from orchestrator (forwarded from Claude Code hooks)
  if (req.url === "/task") {
    const body = JSON.parse(rawBody) as { event: string; task_id: string; task_subject: string };
    process.stderr.write(`[channel:${TOPIC_ID}] task event=${body.event} subject=${body.task_subject}\n`);
    const key = body.task_id || body.task_subject;
    if (body.event === "task_created") {
      state.taskCreated(key, body.task_subject);
    } else if (body.event === "task_completed") {
      state.taskCompleted(key, body.task_subject);
    }
    scheduleActivityRender();
    res.writeHead(200).end("ok");
    return;
  }

  // Tool activity update from orchestrator (PreToolUse hook)
  if (req.url === "/tool") {
    const body = JSON.parse(rawBody) as {
      tool_name: string; tool_input: Record<string, unknown>; agent_id?: string;
    };
    const activity = formatToolActivity(body.tool_name, body.tool_input ?? {});
    if (activity) {
      state.toolStarted({
        toolName: body.tool_name,
        // Same fingerprint function as /tool-post below, run on the SAME
        // (tool_name, tool_input) pair, so a later outcome matches this line.
        fingerprint: makeFingerprint(body.tool_name, body.tool_input ?? {}),
        line: activity,
        agentId: body.agent_id,
      });
      scheduleActivityRender();
    }
    res.writeHead(200).end("ok");
    return;
  }

  // PostToolUse from the orchestrator. A tool of this name finishing means a
  // permission prompt for it was probably answered at the terminal — see
  // permission-relay.ts for why that only suppresses the timeout notice and
  // never closes the prompt. Also carries the outcome (live-turn-view): the
  // daemon computes ok/error_snippet, but the fingerprint that matches this
  // back to its /tool start line is derived here, from the same inputs.
  if (req.url === "/tool-post") {
    const body = JSON.parse(rawBody) as {
      tool_name?: string; tool_input?: Record<string, unknown>; ok?: boolean;
      duration_ms?: number; error_snippet?: string; agent_id?: string;
    };
    const toolName = String(body.tool_name ?? "");
    if (toolName) {
      const marked = permissions.markToolCompleted(toolName);
      if (marked) {
        process.stderr.write(`[channel:${TOPIC_ID}] ${toolName} completed while ${marked.requestId} was pending — assuming it was answered at the terminal\n`);
      }
      state.toolFinished({
        toolName,
        fingerprint: makeFingerprint(toolName, body.tool_input ?? {}),
        ok: body.ok,
        errorSnippet: body.error_snippet,
        durationMs: body.duration_ms,
        agentId: body.agent_id,
      });
      scheduleActivityRender();
    }
    res.writeHead(200).end("ok");
    return;
  }

  // Streamed "thinking out loud" chunks (MessageDisplay hook). Off entirely
  // in "off" mode — tools/agents keep tracking regardless of mode, this is
  // the one signal that mode actually gates.
  if (req.url === "/narration") {
    const body = JSON.parse(rawBody) as {
      delta?: string; index?: number; final?: boolean; message_id?: string; prompt_id?: string;
    };
    if (liveMode !== "off") {
      state.narration({
        delta: String(body.delta ?? ""),
        index: Number(body.index ?? 0),
        final: Boolean(body.final),
        messageId: String(body.message_id ?? ""),
        promptId: String(body.prompt_id ?? ""),
      });
      scheduleActivityRender();
    }
    res.writeHead(200).end("ok");
    return;
  }

  // Subagent lifecycle: start/stop (SubagentStart/SubagentStop hooks) and
  // label (the Agent tool's own PostToolUse description, forwarded once the
  // spawned agent's id is known).
  if (req.url === "/subagent") {
    const body = JSON.parse(rawBody) as {
      event?: string; agent_id?: string; agent_type?: string; last_assistant_message?: string; label?: string;
    };
    const agentId = String(body.agent_id ?? "");
    if (agentId) {
      if (body.event === "start") {
        state.agentStarted(agentId, String(body.agent_type ?? "agent"));
      } else if (body.event === "stop") {
        state.agentStopped(agentId, body.last_assistant_message);
      } else if (body.event === "label" && typeof body.label === "string" && body.label.length > 0) {
        // A missing/empty label must not overwrite an existing one — that
        // would suppress both the label text and the disambiguating id
        // suffix agentLabel's callers rely on when the label is absent.
        state.agentLabel(agentId, body.label);
      }
      scheduleActivityRender();
    }
    res.writeHead(200).end("ok");
    return;
  }

  // Runtime mode switch — validated; an unknown mode leaves the current one
  // untouched rather than silently falling back.
  if (req.url === "/live-mode") {
    const body = JSON.parse(rawBody) as { mode?: string };
    if (body.mode === "full" || body.mode === "summary" || body.mode === "off") {
      liveMode = body.mode;
      state.phaseCollapse = liveMode !== "off";
      // A pending collapse recheck only makes sense in "summary" mode — clear
      // it here too (belt-and-suspenders with the callback's own mode guard)
      // so switching away doesn't leave a stale timer reference outstanding.
      if (liveMode !== "summary" && collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(400).end("invalid mode");
    }
    return;
  }

  // Cancel-turn requested by the user (/cancel or the "Cancel turn" button —
  // see cancel.ts). Resolve any pending ask_user question as cancelled so it
  // isn't left waiting out its own 5-minute timeout for an answer nobody will
  // give. Nothing here confirms whether the interrupt itself worked — see
  // ProcessManager.hasCancelPending for why that's tracked as a sticky fence
  // instead of a per-turn confirmation.
  if (req.url === "/cancel-ask") {
    askRelay.cancelAll();
    res.writeHead(200).end("ok");
    return;
  }

  // Done signal — mode-aware turn-end handling (completed phases stay as
  // history either way).
  if (req.url === "/done") {
    const now = Date.now();
    state.noteDone(now);
    // A turn shouldn't be able to end while a permission dialog is open, so
    // anything still pending was answered at the terminal (or abandoned). Take
    // its dead buttons out of the chat — but leave the entry and its auto-deny
    // armed, so if that assumption is ever wrong the dialog still gets resolved
    // instead of hanging. Idempotent: /done fires once per turn. Untouched by
    // the mode-aware collapse logic below.
    for (const stale of permissions.markAllAnswered()) {
      process.stderr.write(`[channel:${TOPIC_ID}] turn ended with ${stale.requestId} (${stale.toolName}) still pending — retiring prompt\n`);
      await retirePrompt(stale, "⏱ This prompt was answered at the terminal — buttons removed.");
    }

    if (liveMode === "summary") {
      // Cancel any pending coalesced activity render — a render fired ≤1s
      // from now (RENDER_COALESCE_MS) would otherwise land AFTER the collapse
      // below and rewrite the just-collapsed message back to a live view.
      // Mirrors deliverReply's own cancel-pending-render-before-I-render-
      // myself pattern.
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      // Drop live tool lines the same way full/off does below — the turn's
      // own (foreground) tool activity is over either way; only a still-
      // running background agent's nested lines (unaffected by clearTools)
      // remain relevant while a collapse is deferred.
      state.clearTools();
      if (state.shouldCollapse(now)) {
        await collapseToSummary(now);
      } else {
        // A background agent is still running within the 10-minute grace
        // window — leave the live view up and check back once.
        scheduleCollapseRecheck();
      }
    } else {
      // "full"/"off": today's behavior — drop live tool lines, keep the
      // detailed render (subject to its own budget cap) as the final state.
      state.clearTools();
      if (delivery.messageId) {
        const msg = state.render();
        // Only edit if the rendered message fits — avoids stripping formatting on long responses
        if (msg.length <= HTML_SAFE_LEN) {
          const msgId = delivery.messageId;
          await runSerializedRender(async () => {
            await editFormatted(msgId, msg).catch(() => {});
          });
        }
      }
    }
    res.writeHead(200).end("ok");
    return;
  }

  // Forward text straight to Telegram (orchestrator fallback when Claude
  // responded without calling the reply tool) — no Claude turn involved.
  if (req.url === "/forward") {
    const body = JSON.parse(rawBody) as { text: string };
    const text = String(body.text ?? "").trim();
    if (!text) {
      res.writeHead(400).end("forward requires non-empty text");
      return;
    }
    try {
      await deliverReply(text, false);
      res.writeHead(200).end("ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[channel:${TOPIC_ID}] /forward failed — reply lost: ${msg}\n`);
      res.writeHead(500).end(msg);
    }
    return;
  }

  const body = JSON.parse(rawBody) as {
    content: string;
    meta?: Record<string, string> & { reply_to_message_id?: string; delivery_id?: string };
  };

  // Check for permission verdict before treating as chat. Only consume the
  // message when the id matches a PENDING request — otherwise ordinary replies
  // like "no problem" or "yes please" would be silently eaten as verdicts.
  const m = PERMISSION_REPLY_RE.exec(body.content);
  if (m) {
    const pending = permissions.consume(m[2]);
    if (pending === "closed") {
      // A tap on a button whose prompt has since closed (answered at the
      // terminal, turn ended, or timed out). Swallow it: forwarding "yes abcde"
      // to Claude as chat is worse than dropping a verdict it would ignore.
      process.stderr.write(`[channel:${TOPIC_ID}] stale permission verdict for ${m[2]} — prompt already closed, dropping\n`);
      res.writeHead(200).end("ok");
      return;
    }
    if (pending) {
      const verdict = m[1].toLowerCase().startsWith("y") ? "allow" : "deny";
      process.stderr.write(`[channel:${TOPIC_ID}] permission verdict=${verdict} requestId=${pending.requestId}\n`);

      await mcp.server.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: pending.requestId, behavior: verdict },
      });

      // If denied, inject context so Claude understands and doesn't retry blindly
      if (verdict === "deny") {
        await mcp.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[User denied permission for: ${pending.toolName}. Do not retry this operation without explicitly asking the user first.]`,
            meta: { sender: "system" },
          },
        }).catch(() => {});
      }

      res.writeHead(200).end("ok");
      return;
    }
    // Unknown id — not a verdict we issued. Fall through and treat as chat.
  }

  // ask_user button taps. Resolving methods (pick/submit/custom-start/cancel)
  // wake the tool handler's awaited promise on their own; this branch's only
  // job for those is to drive the *pre-resolution* Telegram UI (rendering the
  // ForceReply prompt) or, for toggle, to redraw the checkbox keyboard.
  //
  // `handled` (distinct from the HTTP-level `consumed`) reports whether this
  // tap actually matched a live request — a stale tap against a respawned
  // process's fresh, empty relay still gets a 2xx from a live port, and
  // without this the caller (handlers/index.ts) would show a false "✅ Got
  // it" instead of a "this may have already closed" toast.
  const askMatch = ASK_VERDICT_RE.exec(body.content.trim());
  if (askMatch) {
    const [, verb, requestId, idxStr] = askMatch;
    const idx = idxStr !== undefined ? Number(idxStr) : undefined;
    process.stderr.write(`[channel:${TOPIC_ID}] ask verdict=${verb} requestId=${requestId}${idx !== undefined ? ` idx=${idx}` : ""}\n`);
    let handled = false;
    let empty = false;

    if (verb === "pick" && idx !== undefined) {
      handled = askRelay.pick(requestId, idx) !== null;
    } else if (verb === "toggle" && idx !== undefined) {
      const pending = askRelay.toggle(requestId, idx);
      handled = pending !== null;
      if (pending && pending.messageId !== null) {
        await telegramPost("editMessageReplyMarkup", {
          chat_id: CHAT_ID,
          message_id: pending.messageId,
          reply_markup: { inline_keyboard: buildAskKeyboard(pending) },
        }).catch(() => {});
      }
    } else if (verb === "submit") {
      const result = askRelay.submit(requestId);
      handled = result !== null;
      empty = result === "empty";
    } else if (verb === "custom") {
      // Claimed synchronously, before any await — a double-tap (or a tap racing
      // a still-in-flight first one) sees customClaimed already true and backs
      // off, instead of sending a second ForceReply prompt that orphans the first.
      if (!askRelay.claimCustom(requestId)) {
        // Not necessarily stale: this could be a still-live request whose FIRST
        // "write my own" tap already claimed it (a genuine double-tap), not a
        // closed one — either way there's nothing new for this tap to do, but
        // only report "not handled" when the request is actually gone.
        handled = askRelay.get(requestId) !== null;
      } else {
        const pending = askRelay.get(requestId)!; // just claimed — still live
        try {
          // Send the ForceReply prompt BEFORE touching the original message's
          // buttons: if this fails, the original stays live and tappable
          // instead of leaving the user with neither. sendPlainOnce, not
          // sendAskPrompt — this message's id is load-bearing for
          // matchCustomReply, so it must never risk a silent duplicate.
          const sentId = await sendPlainOnce("Type your answer as a reply to this message:", {
            reply_markup: { force_reply: true, input_field_placeholder: "Your answer..." },
          });
          if (askRelay.startCustom(requestId, sentId)) {
            handled = true;
            if (pending.messageId !== null) {
              await retireAskMessage(
                pending.messageId,
                `${questionHeaderHtml(pending.question, 0, 1)}\n\n✏️ Reply to the next message with your own answer.`,
                `${questionHeaderPlain(pending.question, 0, 1)}\n\n✏️ Reply to the next message with your own answer.`,
              ).catch(() => {});
            }
          } else {
            // The question resolved another way (timeout/cancel/pick) while we
            // were mid-send — this prompt is now an orphan nobody will ever
            // match a reply to. Record its id as closed (so a reply to it gets
            // a "this closed" notice instead of silently becoming a fresh chat
            // turn), say so on the prompt itself, and report this tap as not
            // handled — the question really had already closed by then.
            handled = false;
            askRelay.markPromptClosed(sentId);
            await retireAskMessage(
              sentId,
              "This question has already been answered, cancelled, or timed out.",
              "This question has already been answered, cancelled, or timed out.",
            ).catch(() => {});
          }
        } catch (err) {
          // Neither the HTML nor the plain send landed — nothing usable was
          // delivered. Release the claim so a retry of "write my own" isn't
          // permanently locked out, and leave the original buttons untouched
          // (never got to retiring them).
          handled = false;
          askRelay.releaseCustomClaim(requestId);
          process.stderr.write(`[channel:${TOPIC_ID}] ask_user custom prompt undeliverable: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } else if (verb === "cancel") {
      handled = askRelay.cancel(requestId) !== null;
    }
    // {consumed:true} tells sendToChannel (message.ts) this POST was a relay
    // verdict, not a chat turn — it must not be recorded as the "last user
    // message" a StopFailure would resend into a fresh session.
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ consumed: true, handled, empty }));
    return;
  }

  // Freeform answer to an ask_user "write my own" prompt. Only consumed when
  // this message is an explicit reply to that exact prompt — never "whatever
  // was typed next" — so an unrelated message always falls through as chat.
  const replyToId = body.meta?.reply_to_message_id ? Number(body.meta.reply_to_message_id) : null;
  if (replyToId !== null && !Number.isNaN(replyToId)) {
    const match = askRelay.matchCustomReply(replyToId);
    if (match === "closed") {
      process.stderr.write(`[channel:${TOPIC_ID}] reply to a closed ask_user prompt (msg ${replyToId}) — dropping\n`);
      await sendFormatted("That question has already been answered, cancelled, or timed out.", { disable_notification: true }).catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ consumed: true }));
      return;
    }
    if (match) {
      process.stderr.write(`[channel:${TOPIC_ID}] ask_user custom answer for ${match}\n`);
      askRelay.resolveCustom(match, body.content);
      // The tool handler's own retirement only reaches the original question
      // message (it never learns this ForceReply prompt's id) — acknowledge
      // this one directly, or it's left looking like it's still waiting.
      retireAskMessage(replyToId, "✅ Got it — thanks!", "✅ Got it — thanks!").catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ consumed: true }));
      return;
    }
    // Not a reply to any custom-answer prompt this relay issued — fall through as chat.
  }

  // System reminders — inject as context without resetting reply state
  if (body.meta?.sender === "system") {
    process.stderr.write(`[channel:${TOPIC_ID}] system reminder — injecting context\n`);
    try {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: { content: body.content, meta: body.meta },
      });
      res.writeHead(200).end("ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500).end(msg);
    }
    return;
  }

  // At-least-once retries: the daemon retries a POST whose response it never
  // saw (postToChannel network retry, scheduler timeout+retry) with the SAME
  // delivery id. If the first copy already made it into Claude, injecting the
  // second would run the same request twice — answer "already got it" instead.
  const deliveryId = body.meta?.delivery_id;
  // A retry can arrive while the FIRST copy's injection is still in flight
  // (daemon's 30s POST timeout < a wedged MCP write). Loop: after every await
  // another waiter may have become the delivery attempt in the meantime — a
  // single check-then-await let a THIRD retry (P3) fall through alongside a
  // second (P2) that already re-tracked, corrupting the dedupe map. Re-check
  // both sets until this request either confirms a duplicate or finds no live
  // attempt and becomes the attempt itself.
  while (deliveryId) {
    if (deliveryDedupe.has(deliveryId)) {
      process.stderr.write(`[channel:${TOPIC_ID}] duplicate delivery ${deliveryId} — dropping\n`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ duplicate: true }));
      return;
    }
    const prior = deliveryDedupe.inflight(deliveryId);
    if (!prior) break;
    if (await prior) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ duplicate: true }));
      return;
    }
  }

  // New inbound message — reset all phase state and task list
  process.stderr.write(`[channel:${TOPIC_ID}] new inbound message — resetting state (was msgId=${delivery.messageId}, phases=${state.phaseCount}, tasks=${state.taskCount})\n`);
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  // A collapse recheck pending for the turn that's ending here is moot — a
  // fresh turn is about to start (and will schedule its own on its own /done).
  clearCollapseTimer();
  delivery.onNewInbound();
  state.turnStarted(Date.now());
  collapsed = false; // fresh turn always starts live, even if the last one ended collapsed

  // Track this injection as in-flight so a retry arriving before it settles
  // awaits the outcome above instead of racing a second injection in.
  const settle = deliveryId ? deliveryDedupe.track(deliveryId) : undefined;

  try {
    // Reminder + user content go out as ONE notification, not two. Two separate
    // notification() calls — even sequentially awaited — let Claude Code start a
    // turn off the first (bare reminder, sender=system) before the second (real
    // content) is attached: on a fresh spawn's very first message this produced
    // a reply like "No user message to respond to yet". Prepending the reminder
    // into the same content string makes that race impossible.
    const content = firstInjectionDone ? body.content : REPLY_REMINDER + body.content;
    firstInjectionDone = true;
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: body.meta,
      },
    });
    // Remember only a delivery that actually reached Claude — remembering a
    // failed injection would turn the daemon's retry into a silent drop.
    settle?.(true);
    res.writeHead(200).end("ok");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`channel-server: notification failed: ${msg}\n`);
    settle?.(false);
    res.writeHead(500).end(msg);
  }
}

const httpServer = createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[channel:${TOPIC_ID}] request failed: ${msg}\n`);
    try {
      if (!res.headersSent) res.writeHead(400);
      res.end("bad request");
    } catch { /* socket gone */ }
  });
});

// Start HTTP first, await bind, then connect MCP
await new Promise<void>((resolve, reject) => {
  httpServer.on("error", (err) => {
    process.stderr.write(`teleclaude channel server HTTP error: ${err.message}\n`);
    reject(err);
  });
  httpServer.listen(PORT, "127.0.0.1", () => {
    process.stderr.write(`teleclaude channel server listening on :${PORT}\n`);
    resolve();
  });
});

await mcp.connect(new StdioServerTransport());
process.stderr.write("teleclaude channel server MCP connected\n");
mcpReady = true;

// Shutdown on signal or MCP close
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("teleclaude channel server: shutting down\n");
  httpServer.close();
  setTimeout(() => process.exit(0), 2000);
}
mcp.server.onclose = shutdown;
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
