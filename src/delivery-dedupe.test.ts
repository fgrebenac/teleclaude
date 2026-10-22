import { describe, it, expect } from "vitest";
import { DeliveryDedupe } from "./delivery-dedupe.js";

describe("DeliveryDedupe", () => {
  it("does not know an id until remembered", () => {
    const d = new DeliveryDedupe();
    expect(d.has("a")).toBe(false);
    d.remember("a");
    expect(d.has("a")).toBe(true);
  });

  it("evicts the oldest id past the cap", () => {
    const d = new DeliveryDedupe(3);
    d.remember("a");
    d.remember("b");
    d.remember("c");
    d.remember("d"); // evicts "a"
    expect(d.has("a")).toBe(false);
    expect(d.has("b")).toBe(true);
    expect(d.has("d")).toBe(true);
  });

  it("remembering a known id is idempotent", () => {
    const d = new DeliveryDedupe(2);
    d.remember("a");
    d.remember("a");
    d.remember("b");
    expect(d.has("a")).toBe(true);
    expect(d.has("b")).toBe(true);
  });

  it("tracks in-flight injections and settles to seen", () => {
    const d = new DeliveryDedupe();
    const settle = d.track("a");
    expect(d.has("a")).toBe(false); // not yet injected
    expect(d.inflight("a")).toBeDefined();
    settle(true);
    expect(d.has("a")).toBe(true);
    expect(d.inflight("a")).toBeUndefined(); // no longer in flight
  });

  it("a failed injection clears the id for a retry", async () => {
    const d = new DeliveryDedupe();
    const settle = d.track("a");
    const outcome = d.inflight("a")!;
    settle(false);
    expect(await outcome).toBe(false);
    expect(d.has("a")).toBe(false);
  });

  it("a concurrent retry learns the first copy landed", async () => {
    const d = new DeliveryDedupe();
    const settle = d.track("a");
    const outcome = d.inflight("a")!;
    settle(true);
    expect(await outcome).toBe(true);
  });

  it("re-tracking after a failed settle works normally", () => {
    const d = new DeliveryDedupe();
    const settle1 = d.track("a");
    settle1(false);
    const settle2 = d.track("a");
    settle2(true);
    expect(d.has("a")).toBe(true);
  });

  it("a second settle call is a no-op and can't corrupt a re-tracked entry", () => {
    const d = new DeliveryDedupe();
    const settle1 = d.track("a");
    settle1(true);
    expect(d.has("a")).toBe(true);

    // Stale second call on the SAME settle closure — must not undo the
    // outcome or touch a later re-track's state.
    settle1(false);
    expect(d.has("a")).toBe(true);

    const settle2 = d.track("a");
    expect(d.inflight("a")).toBeDefined();
    settle1(false); // stale call again — must not delete settle2's map entry
    expect(d.inflight("a")).toBeDefined();
    settle2(true);
    expect(d.has("a")).toBe(true);
    expect(d.inflight("a")).toBeUndefined();
  });
});
