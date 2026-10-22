/**
 * Bounded memory of recently injected delivery ids, so an at-least-once retry
 * (postToChannel's network retry in message.ts, the scheduler's timeout+retry)
 * can't inject the same chat turn into Claude twice.
 *
 * Insertion-ordered Set as an LRU: past the cap the oldest id falls off.
 * That's fine — retries arrive within minutes, not days.
 *
 * Lives in the channel-server process ON PURPOSE (dies with it): a StopFailure
 * resend targets a fresh process after the wedged one was killed, and that
 * copy MUST be delivered, not deduped.
 */
export class DeliveryDedupe {
  #seen = new Set<string>();
  #inflight = new Map<string, { promise: Promise<boolean>; resolve: (ok: boolean) => void }>();
  readonly #max: number;

  constructor(max = 64) {
    this.#max = max;
  }

  has(id: string): boolean {
    return this.#seen.has(id);
  }

  /** A concurrent retry can await the in-flight first copy's outcome. */
  inflight(id: string): Promise<boolean> | undefined {
    return this.#inflight.get(id)?.promise;
  }

  /** Register an injection attempt; call the returned settle exactly once.
   *  The closure is itself idempotent — a second call is a no-op — because a
   *  reachable double-settle (e.g. a response write throwing after settle(true)
   *  runs settle(false) in the catch) would otherwise delete a NEW map entry
   *  a later re-track for the same id had already installed. */
  track(id: string): (ok: boolean) => void {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.#inflight.set(id, { promise, resolve });
    let done = false;
    return (ok: boolean) => {
      if (done) return;
      done = true;
      this.#inflight.delete(id);
      if (ok) this.remember(id);
      resolve(ok);
    };
  }

  /** Record an id AFTER the injection it identifies actually succeeded — a
   *  remembered id that never reached Claude would turn the retry into a drop. */
  remember(id: string): void {
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    if (this.#seen.size > this.#max) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }
}
