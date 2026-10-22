import { log, logError } from "./log.js";
import { splitText } from "./telegram-format.js";

// Must exceed the channel server's worst-case delivery budget, or the abort
// fires while the server is still sending and the fallback DUPLICATES the
// whole answer: sendLong (channel-server.ts) sends chunks sequentially, and
// per chunk the worst case is now 20s HTML attempt + up to 10s 429 wait +
// 20s retry ≈ 50s (the 10s cap is set in sendFormatted/editFormatted in
// channel-server.ts — this budget assumes that cap and must be re-derived if
// it changes). 3 chunks (~11KB answer) ≈ 150s; 180s adds headroom. Anything
// longer is rare enough that the duplicate risk is acceptable over never
// falling back.
const FORWARD_TIMEOUT_MS = 180_000;

export type ForwardOutcome = "forwarded" | "direct" | "lost";

/**
 * Deliver Claude's un-replied last message. Try the channel server's /forward
 * first (it renders markdown and keeps the reply-history message tidy); if that
 * fails for ANY reason — non-2xx, network error, timeout — fall back to sending
 * the raw text straight to Telegram in plain chunks. The daemon has the
 * finished answer in hand here: losing it to a wedged channel server is
 * strictly worse than delivering it unformatted.
 */
export async function forwardWithFallback(opts: {
  topicId: number;
  port: number;
  token: string;
  text: string;
  /** One plain Telegram send (no parse_mode — raw model text must never be
   *  able to break the send). Called once per <=4096-char chunk, in order. */
  sendDirect: (chunk: string) => Promise<unknown>;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}): Promise<ForwardOutcome> {
  const { topicId, port, token, text, sendDirect, fetchFn = fetch } = opts;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-teleclaude-token": token },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (res.ok) return "forwarded";
    log(`[done:fallback] topic=${topicId} /forward failed (${res.status} ${await res.text().catch(() => "")}) — sending the text directly`);
  } catch (err) {
    log(`[done:fallback] topic=${topicId} /forward failed (${err}) — sending the text directly`);
  }
  try {
    for (const chunk of splitText(text)) await sendDirect(chunk);
    return "direct";
  } catch (err) {
    logError(`[done:fallback] topic=${topicId} direct send failed — reply lost:`, err);
    return "lost";
  }
}
