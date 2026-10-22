import { readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Bot } from "grammy";
import { writeJsonAtomic } from "./fs-util.js";
import { log, logError } from "./log.js";
import { getProject } from "./config.js";
import { sendToChannel } from "./handlers/message.js";
import type { ProcessManager } from "./processes.js";

/**
 * Inbound webhook: POST http://127.0.0.1:8800/webhook with header
 * `x-teleclaude-webhook-token: <per-project token>` and body {"message": "…"}.
 * The message takes the SAME sendToChannel path a scheduled run takes, so
 * spawn/resume, readiness waiting, blocked-channel handling and stall alerts
 * all apply. Auth happens on the header, BEFORE the body is read — the same
 * rule the daemon's hook guard follows (daemon.ts's callback server checks
 * the token from the query string before ever reading a body).
 *
 * EXPOSURE MODEL (default, per the brief): the callback server binds
 * 127.0.0.1 only (see daemon.ts). This module never opens a port itself —
 * mounting the /webhook route on the existing loopback-only server is
 * Task 11's job. Exposing this to the internet is the user's own reverse
 * tunnel/proxy's responsibility, by design; teleclaude does not bind a
 * public interface for it.
 */

export interface WebhookEntry {
  token: string;
  chatId: number;
  topicId: number;
  /** Project name at creation time, for listings — the (chat, topic) pair is authoritative. */
  project: string;
  createdAt: number;
  createdBy: number;
}

export interface WebhooksFile {
  hooks: WebhookEntry[];
}

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;

/** Port the callback server (daemon.ts) listens on, and where this route is mounted. */
export const CALLBACK_PORT = 8800;

/**
 * Strip ASCII control characters (except `\n`/`\t`, which are legitimate in a
 * multi-line message) before the body reaches Claude. The message is fully
 * attacker-controlled — anyone with the token, or anyone who can guess/replay
 * it — and it's routed unmodified into `bot.api.sendMessage` and the topic's
 * prompt via `sendToChannel`; stray control bytes (NUL, ANSI escape
 * sequences, etc.) have no legitimate use in either destination.
 */
function sanitizeWebhookMessage(raw: string): string {
  // Filter by char code rather than a regex literal containing raw control
  // bytes in the source, which editors/tools can silently mangle. Keeps \n
  // and \t (0x0A, 0x09); drops every other C0 control (0x00-0x1F) and DEL
  // (0x7F).
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) out += raw[i];
  }
  return out;
}

/** The full localhost webhook URL for display (e.g. in the /webhook command). */
export function webhookUrl(port: number = CALLBACK_PORT): string {
  return `http://127.0.0.1:${port}/webhook`;
}

/** A copy-pasteable curl example for the /webhook command's reply. */
export function webhookCurlExample(token: string, port: number = CALLBACK_PORT): string {
  return `curl -X POST ${webhookUrl(port)} \\\n  -H 'x-teleclaude-webhook-token: ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"message":"deploy finished — check the logs"}'`;
}

function defaultDir(): string {
  return join(homedir(), ".teleclaude");
}

function filePath(dir?: string): string {
  return join(dir ?? defaultDir(), "webhooks.json");
}

let cache: { dir: string; data: WebhooksFile } | undefined;

export function loadWebhooks(dir?: string): WebhooksFile {
  const d = dir ?? defaultDir();
  if (cache?.dir === d) return cache.data;

  const file = filePath(d);
  let data: WebhooksFile = { hooks: [] };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (Array.isArray(parsed?.hooks)) data = { hooks: parsed.hooks };
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try { renameSync(file, backup); } catch { /* ignore */ }
      // Never log the file contents (tokens live in it) — just the fact it was corrupt.
      logError(`[webhook] ${file} is corrupt — starting fresh, original saved as ${backup}`, err);
    }
  }
  cache = { dir: d, data };
  return data;
}

export function saveWebhooks(data: WebhooksFile, dir?: string): void {
  const d = dir ?? defaultDir();
  mkdirSync(d, { recursive: true });
  writeJsonAtomic(filePath(d), data);
  cache = { dir: d, data };
}

export function newWebhookToken(): string {
  return `tw_${randomBytes(24).toString("base64url")}`;
}

/** One webhook per (chat, topic) — setting again replaces (rotates) it. */
export function setWebhook(entry: WebhookEntry, dir?: string): void {
  const data = loadWebhooks(dir);
  data.hooks = data.hooks.filter((h) => !(h.chatId === entry.chatId && h.topicId === entry.topicId));
  data.hooks.push(entry);
  saveWebhooks(data, dir);
}

export function getWebhook(chatId: number, topicId: number, dir?: string): WebhookEntry | undefined {
  return loadWebhooks(dir).hooks.find((h) => h.chatId === chatId && h.topicId === topicId);
}

export function removeWebhook(chatId: number, topicId: number, dir?: string): boolean {
  const data = loadWebhooks(dir);
  const before = data.hooks.length;
  data.hooks = data.hooks.filter((h) => !(h.chatId === chatId && h.topicId === topicId));
  if (data.hooks.length === before) return false;
  saveWebhooks(data, dir);
  return true;
}

/**
 * Constant-time equality. Never `!==` on the raw secret — that comparison
 * short-circuits on the first differing byte, leaking timing information an
 * attacker can use to recover the token one byte at a time. Hashing both
 * sides to a fixed-length SHA-256 digest first means `timingSafeEqual` (which
 * requires equal-length buffers) always has equal-length inputs regardless of
 * the presented token's length, so no length-based timing signal escapes
 * either — a presented "" or a presented 10MB string both hash to 32 bytes.
 */
export function tokensMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Scan every entry with no early exit, so the *lookup* time can't reveal
 * which stored token (if any) partially matched. Only the final decision
 * (`found`/`null`) — never a per-entry short-circuit — is returned.
 */
export function findByToken(hooks: readonly WebhookEntry[], presented: string): WebhookEntry | null {
  let found: WebhookEntry | null = null;
  for (const h of hooks) {
    if (tokensMatch(h.token, presented)) found = h;
  }
  return found;
}

/**
 * Sliding-window rate limiter, bounded in memory. Keys are ours to choose
 * (a stored token, or a fixed literal for auth failures) — never the raw
 * attacker-supplied string — so an attacker cycling arbitrary presented
 * tokens can't grow this map: an unknown token never reaches a per-token
 * key, only the single shared "auth-fail" bucket.
 */
export class RateLimiter {
  #hits = new Map<string, number[]>();
  #max: number;
  #windowMs: number;

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  allow(key: string, now: number): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#max) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}

export function parseWebhookBody(raw: string): { ok: true; message: string } | { ok: false; error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const rawMessage = typeof (body as { message?: unknown })?.message === "string"
    ? (body as { message: string }).message
    : "";
  // Sanitize BEFORE trim/length checks: a message that's all control bytes
  // should read as empty, not sneak past the emptiness check.
  const message = sanitizeWebhookMessage(rawMessage).trim();
  if (!message) return { ok: false, error: 'body must be JSON {"message": "..."}' };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: `message too long (max ${MAX_MESSAGE_CHARS} chars)` };
  return { ok: true, message };
}

/** Per-token delivery budget. */
const tokenLimiter = new RateLimiter(10, 60_000);
/** Global brake on failed-auth probing (localhost-only, but cheap insurance). */
const authFailLimiter = new RateLimiter(30, 60_000);

export async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bot: Bot,
  pm: ProcessManager,
  configDir?: string,
): Promise<void> {
  const finish = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    req.resume();
  };

  if (req.method !== "POST") {
    finish(405, { error: "POST only" });
    return;
  }

  // Auth BEFORE the body: the token is a header, so an unauthenticated caller
  // never gets to stream a body — same rule as the daemon's hook guard.
  const presented = req.headers["x-teleclaude-webhook-token"];
  if (typeof presented !== "string" || !presented) {
    finish(401, { error: "missing x-teleclaude-webhook-token header" });
    return;
  }
  const hook = findByToken(loadWebhooks(configDir).hooks, presented);
  if (!hook) {
    if (!authFailLimiter.allow("auth-fail", Date.now())) {
      finish(429, { error: "too many attempts" });
      return;
    }
    // Never log the presented token itself.
    log("[webhook] rejected unknown token");
    finish(401, { error: "unknown token" });
    return;
  }
  if (!tokenLimiter.allow(hook.token, Date.now())) {
    finish(429, { error: "rate limited (10/min)" });
    return;
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    received += chunk.length;
    if (received > MAX_WEBHOOK_BODY_BYTES) {
      finish(413, { error: "body too large" });
      return;
    }
    chunks.push(chunk);
  }
  const parsed = parseWebhookBody(Buffer.concat(chunks).toString());
  if (!parsed.ok) {
    finish(400, { error: parsed.error });
    return;
  }

  const project = getProject(hook.chatId, hook.topicId, configDir);
  if (!project) {
    finish(410, { error: "project no longer exists" });
    return;
  }

  log(`[webhook] ${hook.project} <- ${parsed.message.slice(0, 80)}`);
  finish(202, { ok: true, project: hook.project });

  // Delivery is async — the same path a scheduled run takes. sendToChannel
  // reports failures into the topic itself, so the webhook caller isn't left
  // holding a socket open for a spawn that can take a minute.
  void (async () => {
    await bot.api.sendMessage(hook.chatId, `🪝 ${parsed.message}`, {
      message_thread_id: hook.topicId,
      disable_notification: true,
    }).catch(() => {});
    const result = await sendToChannel(hook.chatId, hook.topicId, project.path, parsed.message, pm, bot, configDir);
    if (!result.ok) logError(`[webhook] delivery failed for ${hook.project}: ${result.reason ?? "unknown"}`);
  })();
}

/** Clear the cache (for testing). */
export function clearWebhookCache(): void {
  cache = undefined;
}
