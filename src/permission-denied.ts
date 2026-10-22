/**
 * Surfacing auto-mode denials to Telegram.
 *
 * In `auto` permission mode a classifier vets each action, and when it blocks
 * one, Claude Code tells *Claude* ("Blocked by classifier") and shows the user a
 * TUI notification plus an entry in `/permissions` → Recently denied. On a phone
 * neither of those exists, so from Telegram the block is invisible: Claude
 * silently pivots to something else and the user never learns their request was
 * cut short, or why the result looks different from what they asked for.
 *
 * The `PermissionDenied` hook is the only signal we get. It is observability
 * only: the denial has already happened, and the hook can answer `{retry:true}`
 * but a retry with nothing changed would just be blocked again. So this notifies
 * and stops there — escalating to an approval belongs to the permission relay,
 * which Claude Code reaches on its own after 3 consecutive blocks.
 */

/** Denials are bursty — the same blocked action gets retried within seconds. */
export const DENIAL_THROTTLE_MS = 60_000;

/** How much of the tool input to show. Enough to recognise the action. */
const PREVIEW_MAX = 160;

/** Pull the most identifying field out of a tool's input, whatever the tool. */
export function denialPreview(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  const input = toolInput ?? {};
  const candidates = ["command", "file_path", "path", "url", "pattern", "query", "prompt"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value.trim());
  }
  // Unknown shape: show something rather than nothing, but never a huge blob.
  const json = JSON.stringify(input);
  return json && json !== "{}" ? truncate(json) : "";
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= PREVIEW_MAX ? oneLine : `${oneLine.slice(0, PREVIEW_MAX)}…`;
}

/**
 * Throttle key. Deliberately includes the preview, so two *different* blocked
 * commands both get through while one command retried in a loop does not.
 */
export function denialKey(toolName: string, preview: string): string {
  return `${toolName}\u0000${preview}`;
}

/**
 * Remembers which denials were reported recently, per topic. Bounded: a session
 * that trips the classifier hundreds of times must not grow this without limit.
 */
export class DenialThrottle {
  #seen = new Map<string, number>();
  #windowMs: number;
  #max: number;

  constructor(windowMs = DENIAL_THROTTLE_MS, max = 200) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /** True if this denial should be reported now; records it when so. */
  shouldNotify(key: string, now: number): boolean {
    const last = this.#seen.get(key);
    if (last !== undefined && now - last < this.#windowMs) return false;
    this.#prune(now);
    this.#seen.set(key, now);
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }

  #prune(now: number): void {
    for (const [key, at] of this.#seen) {
      if (now - at >= this.#windowMs) this.#seen.delete(key);
    }
    // Still oversized (every entry inside the window) — drop the oldest.
    while (this.#seen.size >= this.#max) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }
  }
}

/**
 * The Telegram message for a denial. Says what was blocked and what the user can
 * do about it, because "blocked" with no recourse is just noise. Caller escapes.
 */
export function formatDenial(toolName: string, preview: string): string {
  const what = preview ? `${toolName}: ${preview}` : toolName;
  return [
    `🚫 Auto mode blocked an action`,
    what,
    "",
    "Claude was told and will try another way. To allow it, switch this topic with /permissions and ask again.",
  ].join("\n");
}
