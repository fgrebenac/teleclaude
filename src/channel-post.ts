import type { ProcessManager } from "./processes.js";

/** The two lookups the helper needs — structural, so tests pass a plain stub. */
export type ChannelTarget = Pick<ProcessManager, "getPort" | "getSpawnToken">;

/** Channel-server endpoints (see channel-server.ts). "" is the root inbound
 *  message endpoint. A new endpoint extends this union deliberately. */
export type ChannelPath = "" | "/forward" | "/done" | "/tool" | "/tool-post" | "/task" | "/narration" | "/subagent" | "/live-mode";

export interface PostToTopicOpts {
  /** Abort the request after this many ms. Omit at fire-and-forget sites. */
  timeoutMs?: number;
}

/**
 * POST a JSON body to a topic's channel server, deriving the port and the
 * per-spawn `x-teleclaude-token` auth header from the ProcessManager — so the
 * header (which every inbound channel-server request requires) can never be
 * forgotten at a call site. Returns null when the topic has no live port.
 * Network errors reject; fire-and-forget callers attach `.catch(() => {})`
 * exactly as the previously inlined fetches did.
 *
 * NOT used by message.ts's postToChannel, which pins a spawn generation and
 * retries — that path keeps its own fetch on purpose (it could adopt this
 * helper internally later).
 */
export async function postToTopic(
  pm: ChannelTarget,
  chatId: number,
  topicId: number,
  path: ChannelPath,
  body: unknown,
  opts?: PostToTopicOpts,
): Promise<Response | null> {
  const port = pm.getPort(chatId, topicId);
  if (!port) return null;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-teleclaude-token": pm.getSpawnToken(chatId, topicId) ?? "" },
    body: JSON.stringify(body),
    ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
}

export interface ChannelResponseFlags { consumed: boolean; duplicate: boolean }

/** Parse the channel server's POST response body: plain "ok", {consumed:true}
 *  (relay verdict — not a chat turn), or {duplicate:true} (retry whose first
 *  copy already injected — must NOT be queued as a fresh delivery). */
export function parseChannelResponseFlags(bodyText: string): ChannelResponseFlags {
  try {
    const parsed = JSON.parse(bodyText) as { consumed?: unknown; duplicate?: unknown } | null;
    return { consumed: parsed?.consumed === true, duplicate: parsed?.duplicate === true };
  } catch {
    return { consumed: false, duplicate: false };
  }
}
