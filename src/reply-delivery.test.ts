import { describe, expect, it } from "vitest";
import { ReplyDelivery, type ReplyTransport } from "./reply-delivery.js";
import { TurnView } from "./turn-view.js";
import { TelegramApiError } from "./telegram-errors.js";

type Sent = { kind: "send" | "edit"; id?: number; text: string };

function makeTransport(opts: { failEdit?: unknown; failSend?: unknown } = {}) {
  const calls: Sent[] = [];
  let nextId = 100;
  const transport: ReplyTransport = {
    async send(text) {
      if (opts.failSend) throw opts.failSend;
      calls.push({ kind: "send", text });
      return { message_id: nextId++ };
    },
    async edit(id, text) {
      if (opts.failEdit) throw opts.failEdit;
      calls.push({ kind: "edit", id, text });
    },
  };
  return { transport, calls };
}

describe("ReplyDelivery", () => {
  it("first reply sends a new message and records its id", async () => {
    const { transport, calls } = makeTransport();
    const d = new ReplyDelivery(new TurnView(5), transport);
    await d.deliver("hello");
    expect(calls).toEqual([{ kind: "send", text: "hello" }]);
    expect(d.messageId).toBe(100);
  });

  it("second reply edits in place with accumulated history", async () => {
    const { transport, calls } = makeTransport();
    const d = new ReplyDelivery(new TurnView(5), transport);
    await d.deliver("one");
    await d.deliver("two");
    expect(calls[1]).toEqual({ kind: "edit", id: 100, text: "one\n\ntwo" });
  });

  it("edit failure falls back to a new message with ONLY the newest phase", async () => {
    const { transport, calls } = makeTransport();
    const d = new ReplyDelivery(new TurnView(5), transport);
    await d.deliver("one");
    // now make edits fail
    (transport.edit as unknown) = async () => { throw new TelegramApiError("editMessageText", "fetch failed", 0); };
    await d.deliver("two");
    const sends = calls.filter((c) => c.kind === "send");
    expect(sends[sends.length - 1].text).toBe("two"); // NOT "one\n\ntwo"
  });

  it("detach: output after a question goes to a NEW message without the frozen history", async () => {
    const { transport, calls } = makeTransport();
    const state = new TurnView(5);
    const d = new ReplyDelivery(state, transport);
    await d.deliver("before the question");
    state.toolStarted({ toolName: "Bash", line: "⚙️ Bash: ls", fingerprint: "f1" });
    d.detach();
    expect(d.messageId).toBeNull();
    state.toolStarted({ toolName: "Bash", line: "⚙️ Bash: pwd", fingerprint: "f2" });
    await d.renderActivity();
    await d.deliver("after the answer");
    expect(calls[1]).toEqual({ kind: "send", text: "⚙️ Bash: pwd" });
    expect(calls[2].kind).toBe("edit");
    expect(calls[2].id).toBe(101);
    expect(calls[2].text).not.toContain("before the question");
    expect(calls[2].text).not.toContain("Bash: ls");
  });

  it("detach: an in-flight send can't re-adopt the frozen message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const transport: ReplyTransport = {
      async send() { await gate; return { message_id: 100 }; },
      async edit() {},
    };
    const d = new ReplyDelivery(new TurnView(5), transport);
    const pending = d.deliver("racing");
    d.detach();
    release();
    await pending;
    expect(d.messageId).toBeNull();
  });

  it("a not-modified edit counts as success", async () => {
    const { transport, calls } = makeTransport();
    const d = new ReplyDelivery(new TurnView(5), transport);
    await d.deliver("one");
    (transport.edit as unknown) = async () => {
      throw new TelegramApiError("editMessageText", "Bad Request: message is not modified", 400);
    };
    await d.deliver("two");
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(1); // no fallback send
  });

  it("rolls back state and id when the send throws", async () => {
    const err = new TelegramApiError("sendMessage", "fetch failed", 0);
    const { transport } = makeTransport({ failSend: err });
    const state = new TurnView(5);
    const d = new ReplyDelivery(state, transport);
    await expect(d.deliver("one")).rejects.toThrow();
    expect(state.phaseCount).toBe(0);
    expect(d.messageId).toBeNull();
  });

  it("rolls over to a new message when history exceeds the limit", async () => {
    const { transport, calls } = makeTransport();
    const d = new ReplyDelivery(new TurnView(5), transport, 50); // tiny limit for the test
    await d.deliver("a".repeat(30));
    await d.deliver("b".repeat(30)); // 30+30+2 > 50 → rollover
    const last = calls[calls.length - 1];
    expect(last.kind).toBe("send");
    expect(last.text).toBe("b".repeat(30));
  });

  it("a reset during an in-flight send is not overwritten by the stale continuation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: Sent[] = [];
    let nextId = 100;
    const transport: ReplyTransport = {
      async send(text) { await gate; calls.push({ kind: "send", text }); return { message_id: nextId++ }; },
      async edit(id, text) { calls.push({ kind: "edit", id, text }); },
    };
    const state = new TurnView(5);
    const d = new ReplyDelivery(state, transport);

    const inflight = d.deliver("old turn answer");
    d.onNewInbound(); // user typed a new message mid-send
    release();
    await inflight;

    expect(d.messageId).toBeNull(); // stale id NOT reinstated
    await d.deliver("new turn answer");
    const last = calls[calls.length - 1];
    expect(last.kind).toBe("send"); // new turn SENDS — never edits the old answer
    expect(last.text).toBe("new turn answer");
  });

  it("a failing stale send does not restore old phases into the new turn", async () => {
    let reject!: (e: unknown) => void;
    const gate = new Promise<never>((_, r) => { reject = r; });
    let callCount = 0;
    const transport: ReplyTransport = {
      async send() {
        callCount += 1;
        if (callCount === 1) return { message_id: 100 };
        return gate as Promise<{ message_id: number }>;
      },
      async edit() { throw new Error("should not edit in this test"); },
    };
    const state = new TurnView(5);
    // Tiny limit forces the racing call's history rollover to clear messageId
    // before it reaches the network step, so it goes through send() (where
    // the state.restore() guard lives) rather than edit().
    const d = new ReplyDelivery(state, transport, 10);

    await d.deliver("first"); // establishes phaseCount=1, messageId=100 → this is what a bug would resurrect
    const inflight = d.deliver("old turn answer"); // snapshot captured here includes "first"
    d.onNewInbound(); // reset → phaseCount 0
    reject(new Error("network"));
    await expect(inflight).rejects.toThrow();
    expect(state.phaseCount).toBe(0); // must NOT come back as 1 ("first" resurrected)
  });

  it("a reset during an in-flight renderActivity send does not record the stale id", async () => {
    let release!: (v: { message_id: number }) => void;
    const gate = new Promise<{ message_id: number }>((r) => { release = r; });
    const calls: Sent[] = [];
    const transport: ReplyTransport = {
      async send(text) { calls.push({ kind: "send", text }); return gate; },
      async edit(id, text) { calls.push({ kind: "edit", id, text }); },
    };
    const state = new TurnView(5);
    state.toolStarted({ toolName: "X", fingerprint: "fp1", line: "🔧 running tool" });
    const d = new ReplyDelivery(state, transport);

    const inflight = d.renderActivity();
    d.onNewInbound(); // user typed a new message while the activity send is in flight
    release({ message_id: 999 });
    await inflight;

    expect(d.messageId).toBeNull(); // stale id NOT recorded into the new turn
  });
});
