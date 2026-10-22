/**
 * Bookkeeping for `ask_user` questions relayed to Telegram.
 *
 * Unlike permission-relay.ts (which only tracks a prompt Claude Code is
 * *already* waiting on through its own MCP verdict channel), this relay is the
 * actual wait: `ask()` returns a Promise that the `ask_user` tool handler
 * awaits directly, and it only resolves when a button tap, a submit, a
 * cancel, a ForceReply answer, or the timeout calls one of the resolve
 * methods below. There is no separate "terminal dialog also live" race to
 * account for — this tool has no terminal UI at all in a Telegram-hosted
 * session. That also means a stranded Promise here is fatal in a way
 * permission-relay.ts never risks: nothing else will ever resolve it, so the
 * `ask_user` tool call — and the turn behind it — hangs forever.
 *
 * Freeform answers are captured via Telegram's native reply-to-message
 * mechanism (a `ForceReply` prompt), not "whatever the next message says":
 * `matchCustomReply` only fires for a message that is an explicit reply to
 * that exact prompt, so an unrelated message never gets silently swallowed as
 * an answer, and slash commands (routed elsewhere entirely) can never be
 * mistaken for one either. A reply to a prompt whose question has since
 * closed (answered another way, cancelled, timed out) is recognised as
 * "closed" rather than falling through as ordinary chat — the same "closed"
 * contract permission-relay.ts uses for a stale verdict tap.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestionInput {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export type AskAnswer =
  | { kind: "picked"; labels: string[] }
  | { kind: "custom"; text: string }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  /** A newer `ask()` call reused this request id before this one resolved. */
  | { kind: "superseded" };

export interface PendingAsk {
  requestId: string;
  question: AskQuestionInput;
  /** Telegram message showing the prompt, once the send succeeds. */
  messageId: number | null;
  /** Indices currently checked, for a multiSelect question. */
  selected: number[];
  /** Message id of the ForceReply prompt, once "write my own" is tapped. */
  customPromptMessageId: number | null;
}

interface Entry extends PendingAsk {
  timer: ReturnType<typeof setTimeout>;
  resolve: (answer: AskAnswer) => void;
  selectedSet: Set<number>;
  /** Set synchronously by claimCustom(), before any Telegram round-trip. */
  customClaimed: boolean;
}

/** How many recently-closed custom-prompt message ids to remember. */
const CLOSED_MEMORY = 50;

/** Defensive copy — options are read-only from here on, whatever the caller does to its own object afterward. */
function cloneQuestion(q: AskQuestionInput): AskQuestionInput {
  return { ...q, options: q.options.map((o) => ({ ...o })) };
}

export class AskRelay {
  #pending = new Map<string, Entry>();
  /** Insertion-ordered ring of custom-prompt message ids whose question has since closed. */
  #closedPromptIds: number[] = [];
  #timeoutMs: number;
  #onTimeout: (p: PendingAsk) => void;

  constructor(opts: { timeoutMs: number; onTimeout: (p: PendingAsk) => void }) {
    this.#timeoutMs = opts.timeoutMs;
    this.#onTimeout = opts.onTimeout;
  }

  get size(): number {
    return this.#pending.size;
  }

  /**
   * Register a question and return a Promise that resolves once it's
   * answered, cancelled, or times out. Arms the timeout immediately — the
   * caller sends the Telegram message after this, so a failed send still
   * leaves a live timer rather than an entry that waits forever.
   *
   * Reusing a live request id resolves the *displaced* entry as "superseded"
   * rather than silently abandoning its Promise — a caller-side id collision
   * must never strand a wait forever.
   */
  ask(requestId: string, question: AskQuestionInput): Promise<AskAnswer> {
    return new Promise((resolve) => {
      const existing = this.#close(requestId);
      if (existing) existing.resolve({ kind: "superseded" });

      const entry: Entry = {
        requestId,
        question: cloneQuestion(question),
        messageId: null,
        selected: [],
        selectedSet: new Set(),
        customPromptMessageId: null,
        customClaimed: false,
        resolve,
        timer: setTimeout(() => {
          this.#close(requestId);
          resolve({ kind: "timeout" });
          // The *original question* message is retired by the tool handler's
          // own `await ask(...)` continuation (same process, same Promise),
          // which has better context (the "question i of n" progress line) —
          // this callback must not also touch it, or the two would race. A
          // ForceReply prompt, if one was sent, is a SEPARATE message the tool
          // handler has no way to reach; retiring that one (if it exists) is
          // exactly what this callback is for. See channel-server.ts.
          try {
            this.#onTimeout(snapshot(entry));
          } catch { /* the timer must not crash the process over a bad callback */ }
        }, this.#timeoutMs),
      };
      this.#pending.set(requestId, entry);
    });
  }

  setMessageId(requestId: string, messageId: number): void {
    const entry = this.#pending.get(requestId);
    if (entry) entry.messageId = messageId;
  }

  get(requestId: string): PendingAsk | null {
    const entry = this.#pending.get(requestId);
    return entry ? snapshot(entry) : null;
  }

  /**
   * Single-select: resolves immediately with the chosen option's label.
   * Refuses once "write my own answer" has been claimed — the original
   * buttons are on their way out (or already gone) in favor of the ForceReply
   * prompt, and letting a race-timed tap on the old buttons *also* resolve
   * the request would leave that ForceReply prompt dangling as a silent
   * orphan instead of a clean, single resolution path.
   */
  pick(requestId: string, optionIndex: number): PendingAsk | null {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.question.multiSelect || pending.customClaimed) return null;
    const option = pending.question.options[optionIndex];
    if (!option) return null; // stale/bad tap — leave the request open
    const entry = this.#close(requestId)!;
    entry.resolve({ kind: "picked", labels: [option.label] });
    return snapshot(entry);
  }

  /**
   * Multi-select: toggles a checkbox without resolving. Returns the updated
   * entry for re-rendering the keyboard, or null for an unknown/closed/
   * out-of-range/single-select/custom-claimed request (see `pick`'s doc for
   * why a claimed request refuses every other resolution path).
   */
  toggle(requestId: string, optionIndex: number): PendingAsk | null {
    const entry = this.#pending.get(requestId);
    if (!entry || !entry.question.multiSelect || entry.customClaimed) return null;
    if (!entry.question.options[optionIndex]) return null;
    if (entry.selectedSet.has(optionIndex)) entry.selectedSet.delete(optionIndex);
    else entry.selectedSet.add(optionIndex);
    entry.selected = [...entry.selectedSet].sort((a, b) => a - b);
    return snapshot(entry);
  }

  /**
   * Multi-select: resolves with whatever is currently checked. Returns
   * "empty" (not closed) rather than resolving on zero selections — the
   * caller should nudge the user instead of silently accepting nothing.
   * Labels are resolved *before* the entry closes, so a lookup surprise can
   * never throw between deleting the entry and resolving its Promise. Refuses
   * once custom-claimed, same reasoning as `pick`.
   */
  submit(requestId: string): PendingAsk | "empty" | null {
    const pending = this.#pending.get(requestId);
    if (!pending || !pending.question.multiSelect || pending.customClaimed) return null;
    if (pending.selectedSet.size === 0) return "empty";
    const labels = pending.selected.map((i) => pending.question.options[i].label);
    const entry = this.#close(requestId)!;
    entry.resolve({ kind: "picked", labels });
    return snapshot(entry);
  }

  /**
   * "Write my own answer" tapped: claim the transition synchronously, before
   * any `await` (Telegram send, message edit) runs. A second tap — a
   * double-tap on the button, or a tap racing a still-in-flight first one —
   * reads `customClaimed` already true and backs off instead of sending a
   * second ForceReply prompt that would orphan the first.
   */
  claimCustom(requestId: string): boolean {
    const entry = this.#pending.get(requestId);
    if (!entry || entry.customClaimed) return false;
    entry.customClaimed = true;
    return true;
  }

  /**
   * Undo a claim that never produced a usable prompt (both the HTML and plain
   * Telegram sends failed) — without this, a claim is permanent and "write my
   * own answer" could never be tapped again for this request, stranding it
   * until the 5-minute timeout even though the original buttons are still live.
   */
  releaseCustomClaim(requestId: string): void {
    const entry = this.#pending.get(requestId);
    if (entry) entry.customClaimed = false;
  }

  /** Remember which ForceReply prompt to expect, once it's actually been sent. */
  startCustom(requestId: string, promptMessageId: number): PendingAsk | null {
    const entry = this.#pending.get(requestId);
    if (!entry) return null;
    entry.customPromptMessageId = promptMessageId;
    return snapshot(entry);
  }

  /**
   * Record a ForceReply prompt's message id as closed without an entry ever
   * carrying it — for the orphan case where the question resolved another way
   * while the prompt was still being sent, so it was never attached to a live
   * entry's `customPromptMessageId` in the first place (and `#close()`, which
   * normally does this bookkeeping, never saw it either).
   */
  markPromptClosed(messageId: number): void {
    this.#rememberClosedPrompt(messageId);
  }

  /**
   * Find the pending request (if any) whose ForceReply prompt this inbound
   * message is a reply to. Returns the request id for an exact, still-open
   * match; `"closed"` when the message replies to a prompt whose question has
   * since resolved another way (so the wiring layer can swallow it with a
   * notice instead of forwarding it as a fresh chat turn); or null when the
   * reply targets something that was never a custom-answer prompt at all.
   */
  matchCustomReply(replyToMessageId: number): string | "closed" | null {
    for (const entry of this.#pending.values()) {
      if (entry.customPromptMessageId === replyToMessageId) return entry.requestId;
    }
    return this.#closedPromptIds.includes(replyToMessageId) ? "closed" : null;
  }

  resolveCustom(requestId: string, text: string): PendingAsk | null {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.customPromptMessageId === null) return null; // custom mode never started
    const entry = this.#close(requestId)!;
    entry.resolve({ kind: "custom", text });
    return snapshot(entry);
  }

  /** Refuses once custom-claimed, same reasoning as `pick` — once "write my own" is
   *  in flight, a stale tap on the old Cancel button must not race it to resolution. */
  cancel(requestId: string): PendingAsk | null {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.customClaimed) return null;
    const entry = this.#close(requestId)!;
    entry.resolve({ kind: "cancelled" });
    return snapshot(entry);
  }

  /**
   * Resolve every pending question as cancelled — used when the turn that
   * asked them is itself being cancelled (see requestCancel in cancel.ts).
   * Reuses the same `{kind: "cancelled"}` resolution as a single ask:cancel
   * button tap, so the ask_user tool handler's own `await ask(...)`
   * continuation retires each question's Telegram message exactly the way it
   * already does for a manual cancel — no separate Telegram-editing logic
   * needed here.
   */
  cancelAll(): void {
    for (const requestId of [...this.#pending.keys()]) {
      const entry = this.#close(requestId);
      entry?.resolve({ kind: "cancelled" });
    }
  }

  #close(requestId: string): Entry | null {
    const entry = this.#pending.get(requestId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.#pending.delete(requestId);
    if (entry.customPromptMessageId !== null) this.#rememberClosedPrompt(entry.customPromptMessageId);
    return entry;
  }

  #rememberClosedPrompt(messageId: number): void {
    this.#closedPromptIds.push(messageId);
    if (this.#closedPromptIds.length > CLOSED_MEMORY) this.#closedPromptIds.shift();
  }
}

function snapshot(entry: Omit<Entry, "timer" | "resolve" | "selectedSet">): PendingAsk {
  return {
    requestId: entry.requestId,
    question: cloneQuestion(entry.question),
    messageId: entry.messageId,
    selected: [...entry.selected],
    customPromptMessageId: entry.customPromptMessageId,
  };
}
