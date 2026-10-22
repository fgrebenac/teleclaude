import type { AutoNameState } from "./auto-name.js";
import { topicKey } from "./bot.js";

/**
 * Per-topic runtime scratch state.
 *
 * Everything short-lived a (chat, topic) conversation accumulates around its
 * Claude Code process — timers, last-reply bookkeeping, delivery state — used
 * to live in ~12 module-level maps across message.ts / daemon.ts /
 * turn-warnings.ts, with cleanup hand-maintained in 5+ places and several maps
 * never cleaned at all. It now lives on ONE TopicRuntime object per topic,
 * with a single dispose() wired to the process-death events.
 *
 * What TopicRuntime is NOT: the ProcessManager's `processes` map stays where
 * it is — it owns PTY mechanics (the process, its port, spawn token, tool
 * watchdogs). TopicRuntime is the scratch state AROUND that process.
 */

/** Named timer slots — at most one live timer per slot per topic.
 *  - typing:       the 4s sendChatAction repeat interval
 *  - typingStop:   the pending "stop typing after settle/grace" one-shot
 *  - stall:        the response-stall hard-alert one-shot
 *  - softWarn:     the earlier, informational stall warning one-shot
 *  - doneDebounce: the 3s "notify on the LAST done" one-shot */
export type TimerSlot = "typing" | "typingStop" | "stall" | "softWarn" | "doneDebounce";

export class TimerBag {
  #timers = new Map<TimerSlot, NodeJS.Timeout>();

  /** Arm a one-shot in a named slot, replacing (and cancelling) whatever the
   *  slot held. The slot empties itself when the timer fires, so `get()` never
   *  reports an already-fired handle. Returns the handle for identity checks
   *  (see the soft-warn guard in message.ts's armStallTimer). */
  setTimeout(slot: TimerSlot, fn: () => void, ms: number): NodeJS.Timeout {
    this.clear(slot);
    const handle = setTimeout(() => {
      if (this.#timers.get(slot) === handle) this.#timers.delete(slot);
      fn();
    }, ms);
    this.#timers.set(slot, handle);
    return handle;
  }

  /** Arm a repeating timer in a named slot, replacing whatever the slot held.
   *  Unlike setTimeout, the slot stays occupied until clear()/clearAll(). */
  setInterval(slot: TimerSlot, fn: () => void, ms: number): NodeJS.Timeout {
    this.clear(slot);
    const handle = setInterval(fn, ms);
    this.#timers.set(slot, handle);
    return handle;
  }

  /** The live handle in a slot, if any. */
  get(slot: TimerSlot): NodeJS.Timeout | undefined {
    return this.#timers.get(slot);
  }

  has(slot: TimerSlot): boolean {
    return this.#timers.has(slot);
  }

  /** Stop and forget a slot's timer. clearTimeout and clearInterval are
   *  interchangeable in Node, so one call covers both kinds. No-op when empty. */
  clear(slot: TimerSlot): void {
    const handle = this.#timers.get(slot);
    if (handle) {
      clearTimeout(handle);
      this.#timers.delete(slot);
    }
  }

  clearAll(): void {
    for (const handle of this.#timers.values()) clearTimeout(handle);
    this.#timers.clear();
  }

  get size(): number {
    return this.#timers.size;
  }
}

/**
 * One logical message delivered (or about to be resent) to a topic's Claude
 * Code session. The id is the idempotency key: it stays the same across every
 * retry of the same message, and the channel server refuses to inject an id
 * it has already injected (see delivery-dedupe.ts).
 */
export interface DeliveryEnvelope {
  /** Idempotency key — stable across retries of the same logical message. */
  id: string;
  content: string;
  /** Telegram message id of the user message this came from, when there is one. */
  telegramMessageId?: number;
  /** When the envelope was delivered (epoch ms). */
  sentAt: number;
  /** Already auto-resent once after a StopFailure — never resent again. */
  resent: boolean;
}

/** Queue cap: a StopFailure resend never replays more than this many messages. */
const PENDING_TURN_MAX = 10;

export class TopicRuntime {
  readonly chatId: number;
  readonly topicId: number;
  readonly timers = new TimerBag();

  // ── Process-scoped scratch — reset by dispose() when the process dies ──

  /** Last reply-tool message of the current turn + how many replies it made.
   *  Drives the typing indicator's settle-vs-grace decision and done-notify. */
  lastReplyMsg?: { chatId: number; messageId: number; text: string; replyCount: number };
  /** Replies since the last done — the daemon's missed-reply /forward check. */
  replyCount = 0;
  /** The one tracked long-running-task warning message (see turn-warnings.ts):
   *  its Telegram message id + current severity. Process-scoped: a dead
   *  process's warning is retired by the kill flow, and tracking it further
   *  would edit a message about work that no longer exists. */
  warning?: { messageId: number; severity: "soft" | "hard" };
  /** Dirty-state fingerprint of the last turn-end /review prompt we sent, so an
   *  unchanged tree isn't re-nagged turn after turn. Process-scoped: after a
   *  kill/resume a single re-prompt for the same tree is acceptable. */
  lastReviewSig?: string;
  /** tool_use events since the last delivered message — feeds the /receipts
   *  🔧 count. Reset on every successful delivery (see sendToChannel), not on
   *  `done`: the done-debounce can fire more than once per logical turn, and
   *  the count must describe the whole turn, not just its last Stop. */
  toolCount = 0;
  /** Messages delivered since the last completed turn (`done`), oldest first.
   *  Cleared on `done` AND on every process death (dispose) — NOT a "survives
   *  dispose" field like the old single lastUserMessage slot was: a StopFailure
   *  landing after a Cancel-turn kill (or /stop, Force Stop, /new, a plain
   *  disconnect) must not find stale envelopes here and resend a message the
   *  user already asked to stop. The StopFailure error branch instead snapshots
   *  `takeResendable()` BEFORE calling kill() — kill() fires "killed"
   *  synchronously, and that dispose() is what empties this — so the resend
   *  still has the right envelopes even though the queue itself doesn't
   *  survive. See CLAUDE.md's "Delivery is idempotent and ledgered" bullet. */
  pendingTurn: DeliveryEnvelope[] = [];
  /** Count of envelopes shifted out of `pendingTurn` past `PENDING_TURN_MAX` —
   *  messages a StopFailure resend can never recover, because they were
   *  evicted before the failure even happened. Reset wherever `pendingTurn`
   *  is cleared (dispose() and clearTurn()), same lifetime as the queue it
   *  describes. Read by the StopFailure notice (message.ts) BEFORE the
   *  kill()/dispose() that would zero it, alongside the `takeResendable()`
   *  snapshot. */
  pendingEvictedCount = 0;
  /** When the last sendChatAction went out — throttles the immediate typing
   *  nudge that follows each bot message (see keepAliveActionFor). */
  lastTypingActionAt?: number;
  /** The typing indicator is UNBACKED: no in-flight delivery guarantees a
   *  `done` that will stop it. Set when activity resurrects the indicator
   *  from a full stop AND when a turn's done/forwarded schedules its settle
   *  stop (activity landing inside that window continues without a backing
   *  delivery too — the trailing-subagent case). Unbacked runs carry an idle
   *  cap (see keepAliveActionFor). Cleared when a real delivery starts the
   *  indicator (beginTurnTyping). */
  typingUnbacked = false;

  // ── Topic memory — deliberately SURVIVES dispose() ──

  /** In-flight spawn's readiness promise. Owned by sendToChannel's spawn
   *  closure (set before the await, always removed in its own finally) —
   *  dispose must not touch it: the "disconnected" notice suppression reads it
   *  AFTER the process already exited, to know a delivery is still in flight. */
  topicReady?: Promise<number | null>;
  /** When the last user message arrived — cancels stale done notifications. */
  lastUserMessageAt?: number;
  /** When this topic's channel was last seen org-blocked. Gates respawns for
   *  the cooldown — the blocked process is killed (which disposes), so the
   *  gate only works because this survives dispose. Cleared on healthy spawn. */
  channelBlockedAt?: number;
  /** The session's cumulative output-token total (getSessionUsage) at the
   *  previous /receipts receipt. Survives dispose deliberately: a resumed
   *  session's transcript keeps accumulating in the same file, so the baseline
   *  is still meaningful after a respawn. A /new (fresh transcript) makes the
   *  next delta come out negative, which the caller clamps to 0 — best-effort,
   *  not exact. Undefined means "no receipt sent yet" — the very next one omits
   *  the tokens segment rather than reporting the session's whole lifetime total. */
  receiptTokenBaseline?: number;
  /** Which process the post-turn auto-name already tried (auto-name.ts).
   *  Survives dispose harmlessly: it's keyed by pid, so a respawn — a new
   *  pid — is a fresh attempt anyway. */
  autoName: AutoNameState = {};

  constructor(chatId: number, topicId: number) {
    this.chatId = chatId;
    this.topicId = topicId;
  }

  /** The topic's process died (kill or unexpected exit). Clears every timer,
   *  the process-scoped scratch, AND the pending-turn envelope queue — a
   *  process death that ISN'T a completed turn (kill, /stop, Force Stop,
   *  /new, disconnect) must drop whatever was queued so it can never be
   *  resent later as if it were still in flight. Topic memory (below) still
   *  survives on purpose — each surviving field there documents what breaks
   *  otherwise. Idempotent. */
  dispose(): void {
    this.timers.clearAll();
    this.lastReplyMsg = undefined;
    this.replyCount = 0;
    this.warning = undefined;
    this.lastReviewSig = undefined;
    this.pendingTurn = [];
    this.pendingEvictedCount = 0;
    this.toolCount = 0;
    this.lastTypingActionAt = undefined;
    this.typingUnbacked = false;
  }

  /** Record a delivered chat message as pending for the current turn.
   *  Id-deduped: a retry of an envelope already queued must not double it. */
  noteDelivered(envelope: DeliveryEnvelope): void {
    if (this.pendingTurn.some((e) => e.id === envelope.id)) return;
    this.pendingTurn.push(envelope);
    if (this.pendingTurn.length > PENDING_TURN_MAX) {
      this.pendingTurn.shift();
      this.pendingEvictedCount++;
    }
  }

  /** Envelopes eligible for a StopFailure auto-resend, oldest first. Every
   *  returned envelope is marked resent BEFORE this returns, so a repeat
   *  failure mid-resend can never loop. */
  takeResendable(): DeliveryEnvelope[] {
    const eligible = this.pendingTurn.filter((e) => !e.resent);
    for (const e of eligible) e.resent = true;
    return eligible;
  }

  /** The turn completed — everything delivered into it is accounted for.
   *  (Called on `done`; see the delivery-ledger bullet in CLAUDE.md for the
   *  intermediate-done trade-off this encodes.) */
  clearTurn(): void {
    this.pendingTurn = [];
    this.pendingEvictedCount = 0;
  }
}

const registry = new Map<string, TopicRuntime>();

/** Get-or-create the runtime for a (chat, topic) pair. */
export function topicRuntime(chatId: number, topicId: number): TopicRuntime {
  const key = topicKey(chatId, topicId);
  let rt = registry.get(key);
  if (!rt) {
    rt = new TopicRuntime(chatId, topicId);
    registry.set(key, rt);
  }
  return rt;
}

/** The runtime for a pair if one exists — never creates. */
export function peekTopicRuntime(chatId: number, topicId: number): TopicRuntime | undefined {
  return registry.get(topicKey(chatId, topicId));
}

/** Dispose and forget a topic's runtime entirely — for project deletion.
 *  (Process death alone only dispose()s; the runtime object survives so
 *  topic memory like the blocked-channel cooldown can gate the next spawn.) */
export function removeTopicRuntime(chatId: number, topicId: number): void {
  const key = topicKey(chatId, topicId);
  registry.get(key)?.dispose();
  registry.delete(key);
}
