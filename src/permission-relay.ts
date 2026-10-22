/**
 * Bookkeeping for permission prompts relayed to Telegram.
 *
 * The hard part is that Claude Code never tells us a prompt was *answered at
 * the local terminal*. The relay is parallel by design: the terminal dialog and
 * the Telegram prompt are both live, and whichever answer lands first wins. So a
 * pending entry here can already be dead, and firing the 5-minute auto-deny on
 * it used to inject "auto-denied after timeout" as fact about a call that had
 * actually been approved and run.
 *
 * Two signals close the gap, and NEITHER cancels the auto-deny. That is the
 * central rule here: both are inferences, and the cost of acting on a wrong
 * inference must never be a stranded turn. A suppressed notice is cheap; a
 * cancelled safety net means the dialog waits forever with nobody watching it.
 *
 *   - A tool with that name completed (PostToolUse). Suggestive, not proof:
 *     Claude runs tools in parallel, so an auto-approved `Bash` can finish while
 *     a *different* `Bash` is still waiting for approval. `markToolCompleted`
 *     sets `assumedAnswered`, which only suppresses the misleading notice.
 *
 *   - Turn ended (Stop hook). Near-certain — a turn shouldn't be able to finish
 *     while a dialog is open — but `markAllAnswered` still only marks, and
 *     additionally reports the prompt as retirable so its dead buttons can be
 *     taken out of the chat. The timer stays armed, so if that premise is ever
 *     wrong the auto-deny still resolves the dialog instead of hanging.
 */

export interface PendingPermission {
  /** Request id as Claude Code issued it (original casing). */
  requestId: string;
  toolName: string;
  /** Telegram message showing the prompt, once the send succeeds. */
  messageId: number | null;
  /**
   * A tool of this name has since completed, so this prompt was probably
   * answered at the terminal. Not certain — see the class doc.
   */
  assumedAnswered: boolean;
  /** Its Telegram buttons have already been taken down; don't announce twice. */
  promptRetired: boolean;
}

interface Entry extends PendingPermission {
  timer: ReturnType<typeof setTimeout>;
}

/** How many recently-closed ids to remember, so late verdicts are recognised. */
export const CLOSED_MEMORY = 50;

export type CloseReason = "verdict" | "turn-ended" | "timeout";

export class PermissionRelay {
  #pending = new Map<string, Entry>();
  /** Insertion-ordered ring of closed ids. No clock: bounded by count. */
  #closed: string[] = [];
  #timeoutMs: number;
  #onTimeout: (p: PendingPermission) => void;

  constructor(opts: { timeoutMs: number; onTimeout: (p: PendingPermission) => void }) {
    this.#timeoutMs = opts.timeoutMs;
    this.#onTimeout = opts.onTimeout;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Ids are matched case-insensitively — phone autocorrect capitalises replies. */
  static key(requestId: string): string {
    return requestId.toLowerCase();
  }

  /**
   * Register a prompt and arm its auto-deny. Called *before* the Telegram send:
   * if that send fails there must still be a timer, or the terminal dialog waits
   * forever with nobody watching it.
   */
  add(requestId: string, toolName: string): void {
    const key = PermissionRelay.key(requestId);
    const existing = this.#pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const entry: Entry = {
      requestId,
      toolName,
      messageId: null,
      assumedAnswered: false,
      promptRetired: false,
      timer: setTimeout(() => {
        const live = this.#pending.get(key);
        this.#pending.delete(key);
        this.#remember(key);
        if (live) this.#onTimeout(snapshot(live));
      }, this.#timeoutMs),
    };
    this.#pending.set(key, entry);
  }

  /** Record the Telegram message id so the prompt can be edited when it closes. */
  setMessageId(requestId: string, messageId: number): void {
    const entry = this.#pending.get(PermissionRelay.key(requestId));
    if (entry) entry.messageId = messageId;
  }

  /**
   * A verdict arrived for this id. Returns the entry to act on, `"closed"` if
   * the prompt already closed (swallow it — forwarding a stale "yes abcde" to
   * Claude as chat is worse than dropping it), or null if we never issued it.
   */
  consume(requestId: string): PendingPermission | "closed" | null {
    const key = PermissionRelay.key(requestId);
    const entry = this.#pending.get(key);
    if (!entry) return this.#closed.includes(key) ? "closed" : null;
    clearTimeout(entry.timer);
    this.#pending.delete(key);
    this.#remember(key);
    return snapshot(entry);
  }

  /**
   * PostToolUse for `toolName`. Marks the oldest pending prompt for that tool as
   * probably-answered without closing it. Returns the entry it marked, or null.
   */
  markToolCompleted(toolName: string): PendingPermission | null {
    for (const entry of this.#pending.values()) {
      if (entry.toolName === toolName && !entry.assumedAnswered) {
        entry.assumedAnswered = true;
        return snapshot(entry);
      }
    }
    return null;
  }

  /**
   * The turn ended, so nothing should still be waiting. Marks every pending
   * prompt answered and reports the ones whose Telegram buttons haven't been
   * taken down yet — the caller retires those. Entries and timers deliberately
   * survive: see the class doc on why no inference here cancels the safety net.
   * Idempotent, because the Stop hook fires once per turn, not once per message.
   */
  markAllAnswered(): PendingPermission[] {
    const retirable: PendingPermission[] = [];
    for (const entry of this.#pending.values()) {
      entry.assumedAnswered = true;
      if (!entry.promptRetired) {
        entry.promptRetired = true;
        retirable.push(snapshot(entry));
      }
    }
    return retirable;
  }

  wasRecentlyClosed(requestId: string): boolean {
    return this.#closed.includes(PermissionRelay.key(requestId));
  }

  #remember(key: string): void {
    this.#closed.push(key);
    if (this.#closed.length > CLOSED_MEMORY) this.#closed.shift();
  }
}

function snapshot(entry: Entry): PendingPermission {
  return {
    requestId: entry.requestId,
    toolName: entry.toolName,
    messageId: entry.messageId,
    assumedAnswered: entry.assumedAnswered,
    promptRetired: entry.promptRetired,
  };
}
