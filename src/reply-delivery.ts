import { HTML_SAFE_LEN } from "./telegram-format.js";
import type { TurnView } from "./turn-view.js";
import { classifyTelegramError } from "./telegram-errors.js";

export interface ReplyTransport {
  /** Send a (possibly long, will be split downstream) message; returns the last message id. */
  send(text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }>;
  /** Edit an existing message in place. */
  edit(messageId: number, text: string): Promise<void>;
}

/**
 * Owns the edit-in-place vs new-message decision for reply delivery, the
 * current Telegram message id, and the turn generation (see onNewInbound).
 * Extracted from channel-server.ts so the orchestration is testable.
 */
export class ReplyDelivery {
  #messageId: number | null = null;
  #generation = 0;

  constructor(
    private readonly state: TurnView,
    private readonly transport: ReplyTransport,
    private readonly htmlSafeLen = HTML_SAFE_LEN,
  ) {}

  get messageId(): number | null { return this.#messageId; }
  get generation(): number { return this.#generation; }

  /** New inbound user message: reset history and invalidate in-flight deliveries. */
  onNewInbound(): void {
    this.#generation += 1;
    this.#messageId = null;
    this.state.reset();
  }

  /**
   * Freeze the current message: something else was posted below it (an
   * ask_user question), so later output starts a new message underneath
   * instead of editing one the user has scrolled past. Bumps the generation
   * so an in-flight send can't record its id as the live message again.
   */
  detach(): void {
    this.#generation += 1;
    this.#messageId = null;
    this.state.dropShown();
  }

  async deliver(text: string, extra: Record<string, unknown> = {}): Promise<void> {
    const gen = this.#generation;
    const saved = this.state.snapshot();
    const savedMsgId = this.#messageId;

    this.state.closePhase(text, Date.now());

    // Full history over the limit → start a new message with only the latest phase.
    // Deliberately renderFull() (uncapped), not render(): render()'s own
    // internal budget (TurnView's live-activity cap, currently BELOW
    // htmlSafeLen) would make this comparison never see the true length —
    // and could even render as "" for an oversized single phase, which
    // Telegram then rejects outright ("message text is empty"). This
    // rollover-to-new-message path, plus sendLong's chunk-splitting on the
    // transport side, are what's actually meant to bound delivered length.
    if (this.state.renderFull().length > this.htmlSafeLen && this.#messageId) {
      this.state.keepLastPhase();
      this.#messageId = null;
    }

    let rendered = this.state.renderFull();
    if (this.#messageId && rendered.length <= this.htmlSafeLen) {
      try {
        await this.transport.edit(this.#messageId, rendered);
        return;
      } catch (err) {
        if (classifyTelegramError(err) === "not-modified") return; // identical content = delivered
        if (gen !== this.#generation) throw err; // turn ended mid-edit — don't mutate the new turn's state
        // Edit failed — the old message already SHOWS the prior phases, so the
        // fallback message carries only the newest phase. Resending the full
        // history here is the duplicate-first-part bug observed live
        // (2026-08-24).
        this.state.keepLastPhase();
        this.#messageId = null;
        rendered = this.state.renderFull();
      }
    }

    try {
      const result = await this.transport.send(rendered, extra);
      // A new inbound message may have reset state while the send was in
      // flight — recording the stale id would make the next turn's first
      // reply EDIT this turn's answer out of the chat.
      if (gen === this.#generation) this.#messageId = result.message_id;
    } catch (err) {
      // Roll back so retried calls don't add duplicate phases — but never
      // into a newer turn's fresh state.
      if (gen === this.#generation) {
        this.state.restore(saved);
        this.#messageId = savedMsgId;
      }
      throw err;
    }
  }

  /** Render current activity (tool lines): edit in place or start a message. */
  async renderActivity(extra: Record<string, unknown> = {}): Promise<void> {
    const gen = this.#generation;
    const rendered = this.state.render();
    if (!rendered) return;
    if (this.#messageId) {
      await this.transport.edit(this.#messageId, rendered).catch(() => {});
    } else {
      const result = await this.transport.send(rendered, extra).catch(() => null);
      if (result && gen === this.#generation) this.#messageId = result.message_id;
    }
  }
}
