import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AskRelay, type AskAnswer, type AskQuestionInput, type PendingAsk } from "./ask-relay.js";

const TIMEOUT = 5 * 60 * 1000;

const singleSelect: AskQuestionInput = {
  question: "Which library?",
  header: "Library",
  options: [{ label: "React Query" }, { label: "SWR" }],
};

const multiSelect: AskQuestionInput = {
  question: "Which environments?",
  header: "Envs",
  multiSelect: true,
  options: [{ label: "dev" }, { label: "staging" }, { label: "prod" }],
};

function makeRelay() {
  const timedOut: PendingAsk[] = [];
  const relay = new AskRelay({ timeoutMs: TIMEOUT, onTimeout: (p) => { timedOut.push(p); } });
  return { relay, timedOut };
}

describe("AskRelay", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves the ask() promise when an option is picked", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);
    expect(relay.size).toBe(1);

    const picked = relay.pick("abcde", 0);
    expect(picked).toMatchObject({ requestId: "abcde" });
    expect(relay.size).toBe(0);

    const answer = await promise;
    expect(answer).toEqual<AskAnswer>({ kind: "picked", labels: ["React Query"] });
  });

  it("times out to a timeout answer and reports it, once", async () => {
    const { relay, timedOut } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);

    vi.advanceTimersByTime(TIMEOUT);
    expect(await promise).toEqual<AskAnswer>({ kind: "timeout" });
    expect(timedOut).toHaveLength(1);
    expect(relay.size).toBe(0);
  });

  it("ignores a pick for an unknown or already-closed request", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    relay.pick("abcde", 0);
    expect(relay.pick("abcde", 1)).toBeNull(); // already closed
    expect(relay.pick("zzzzz", 0)).toBeNull(); // never issued
  });

  it("ignores a pick with an out-of-range option index", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.pick("abcde", 5)).toBeNull();
    expect(relay.size).toBe(1); // still open — a stale/bad tap didn't resolve it
  });

  it("toggles multi-select options without resolving", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", multiSelect);

    let state = relay.toggle("abcde", 0);
    expect(state?.selected).toEqual([0]);
    state = relay.toggle("abcde", 2);
    expect(state?.selected).toEqual([0, 2]);
    state = relay.toggle("abcde", 0); // untoggle
    expect(state?.selected).toEqual([2]);
    expect(relay.size).toBe(1); // toggling never resolves
  });

  it("refuses to toggle a single-select question", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.toggle("abcde", 0)).toBeNull();
  });

  it("rejects an empty multi-select submit without closing the request", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", multiSelect);
    expect(relay.submit("abcde")).toBe("empty");
    expect(relay.size).toBe(1);
  });

  it("resolves a multi-select submit with every checked label", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", multiSelect);
    relay.toggle("abcde", 2);
    relay.toggle("abcde", 0);
    const submitted = relay.submit("abcde");
    expect(submitted).not.toBeNull();
    expect(await promise).toEqual<AskAnswer>({ kind: "picked", labels: ["dev", "prod"] });
  });

  it("only consumes a freeform reply that targets the exact ForceReply prompt", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);
    relay.startCustom("abcde", 999);

    expect(relay.matchCustomReply(111)).toBeNull(); // reply to something else
    expect(relay.matchCustomReply(999)).toBe("abcde");

    relay.resolveCustom("abcde", "Actually, use tRPC");
    expect(await promise).toEqual<AskAnswer>({ kind: "custom", text: "Actually, use tRPC" });
  });

  it("claims custom mode exactly once, so a double-tap can't orphan a second ForceReply prompt", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.claimCustom("abcde")).toBe(true);
    expect(relay.claimCustom("abcde")).toBe(false); // second tap — already claimed
  });

  it("refuses to claim custom mode for an unknown or already-closed request", () => {
    const { relay } = makeRelay();
    expect(relay.claimCustom("zzzzz")).toBe(false);
    relay.ask("abcde", singleSelect);
    relay.cancel("abcde");
    expect(relay.claimCustom("abcde")).toBe(false);
  });

  it("refuses pick/toggle/submit/cancel once custom mode is claimed, so a race can't leave the ForceReply prompt orphaned", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", multiSelect);
    relay.toggle("abcde", 0); // fine before the claim
    relay.claimCustom("abcde");
    expect(relay.pick("abcde", 0)).toBeNull();
    expect(relay.toggle("abcde", 1)).toBeNull();
    expect(relay.submit("abcde")).toBeNull();
    expect(relay.cancel("abcde")).toBeNull();
    expect(relay.size).toBe(1); // none of those closed it
  });

  it("allows pick again after a released claim (failed ForceReply send)", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);
    relay.claimCustom("abcde");
    expect(relay.pick("abcde", 0)).toBeNull(); // blocked while claimed
    relay.releaseCustomClaim("abcde");
    relay.pick("abcde", 0); // now allowed again
    expect(await promise).toEqual<AskAnswer>({ kind: "picked", labels: ["React Query"] });
  });

  it("lets a released claim be retaken, so a failed ForceReply send doesn't strand the request", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.claimCustom("abcde")).toBe(true);
    relay.releaseCustomClaim("abcde");
    expect(relay.claimCustom("abcde")).toBe(true); // retry succeeds, not stuck forever
  });

  it("marks an orphaned prompt id as closed even though it was never attached to a live entry", () => {
    const { relay } = makeRelay();
    relay.markPromptClosed(4242);
    expect(relay.matchCustomReply(4242)).toBe("closed");
    expect(relay.matchCustomReply(999)).toBeNull(); // untouched ids stay null
  });

  it("does not treat a reply as custom before 'write my own' was ever tapped", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.matchCustomReply(999)).toBeNull();
  });

  it("resolves cancel distinctly from timeout or pick", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);
    relay.cancel("abcde");
    expect(await promise).toEqual<AskAnswer>({ kind: "cancelled" });
  });

  it("resolves the displaced entry as superseded instead of stranding it on an id collision", async () => {
    const { relay } = makeRelay();
    const first = relay.ask("abcde", singleSelect);
    const second = relay.ask("abcde", multiSelect);

    expect(await first).toEqual<AskAnswer>({ kind: "superseded" });
    relay.toggle("abcde", 0);
    relay.submit("abcde");
    expect(await second).toEqual<AskAnswer>({ kind: "picked", labels: ["dev"] });
  });

  it("does not let a mutated snapshot corrupt internal state or strand the promise", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", multiSelect);
    relay.toggle("abcde", 1);
    const snap = relay.get("abcde")!;
    snap.selected.push(999); // mutate the returned snapshot
    snap.question.options.length = 0; // and try to corrupt the options list

    const submitted = relay.submit("abcde");
    expect(submitted).not.toBeNull();
    expect(await promise).toEqual<AskAnswer>({ kind: "picked", labels: ["staging"] });
  });

  it("rejects pick() on a multi-select question and submit() on a single-select one", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", multiSelect);
    expect(relay.pick("abcde", 0)).toBeNull();
    relay.ask("fghij", singleSelect);
    expect(relay.submit("fghij")).toBeNull();
    expect(relay.size).toBe(2); // neither bad call closed its request
  });

  it("refuses to resolve a custom answer before 'write my own' was tapped", () => {
    const { relay } = makeRelay();
    relay.ask("abcde", singleSelect);
    expect(relay.resolveCustom("abcde", "text")).toBeNull();
    expect(relay.size).toBe(1);
  });

  it("recognizes a reply to a prompt whose question already closed as 'closed', not a fresh match", async () => {
    const { relay } = makeRelay();
    const promise = relay.ask("abcde", singleSelect);
    relay.startCustom("abcde", 999);
    relay.cancel("abcde");
    await promise;

    expect(relay.matchCustomReply(999)).toBe("closed");
    expect(relay.matchCustomReply(111)).toBeNull(); // never was a prompt at all
  });

  it("survives a throwing onTimeout callback without leaving the promise unresolved", async () => {
    const relay = new (await import("./ask-relay.js")).AskRelay({
      timeoutMs: TIMEOUT,
      onTimeout: () => { throw new Error("boom"); },
    });
    const promise = relay.ask("abcde", singleSelect);
    vi.advanceTimersByTime(TIMEOUT);
    expect(await promise).toEqual<AskAnswer>({ kind: "timeout" });
  });

  it("keeps two concurrent requests independent", async () => {
    const { relay } = makeRelay();
    const p1 = relay.ask("aaaaa", singleSelect);
    const p2 = relay.ask("bbbbb", multiSelect);
    relay.pick("aaaaa", 1);
    relay.toggle("bbbbb", 1);
    relay.submit("bbbbb");
    expect(await p1).toEqual<AskAnswer>({ kind: "picked", labels: ["SWR"] });
    expect(await p2).toEqual<AskAnswer>({ kind: "picked", labels: ["staging"] });
  });

  it("cancelAll resolves every pending question as cancelled", async () => {
    const { relay } = makeRelay();
    const p1 = relay.ask("aaaa", singleSelect);
    const p2 = relay.ask("bbbb", multiSelect);
    expect(relay.size).toBe(2);

    relay.cancelAll();
    expect(relay.size).toBe(0);

    expect(await p1).toEqual<AskAnswer>({ kind: "cancelled" });
    expect(await p2).toEqual<AskAnswer>({ kind: "cancelled" });
  });

  it("cancelAll is a no-op when nothing is pending", () => {
    const { relay } = makeRelay();
    expect(() => relay.cancelAll()).not.toThrow();
    expect(relay.size).toBe(0);
  });
});
