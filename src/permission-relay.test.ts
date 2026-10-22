import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PermissionRelay, CLOSED_MEMORY, type PendingPermission } from "./permission-relay.js";

const TIMEOUT = 5 * 60 * 1000;

function makeRelay() {
  const timedOut: PendingPermission[] = [];
  const relay = new PermissionRelay({ timeoutMs: TIMEOUT, onTimeout: (p) => { timedOut.push(p); } });
  return { relay, timedOut };
}

describe("PermissionRelay", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("auto-denies a prompt nobody answered", () => {
    const { relay, timedOut } = makeRelay();
    relay.add("abcde", "Bash");
    expect(relay.size).toBe(1);

    vi.advanceTimersByTime(TIMEOUT);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ requestId: "abcde", toolName: "Bash", assumedAnswered: false });
    expect(relay.size).toBe(0);
  });

  it("consumes a verdict and cancels the auto-deny", () => {
    const { relay, timedOut } = makeRelay();
    relay.add("abcde", "Bash");

    const consumed = relay.consume("abcde");
    expect(consumed).toMatchObject({ requestId: "abcde", toolName: "Bash" });

    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(timedOut).toHaveLength(0);
  });

  it("matches ids case-insensitively but replies with the id as issued", () => {
    // Phone autocorrect capitalises; the verdict must echo Claude Code's casing.
    const { relay } = makeRelay();
    relay.add("abcde", "Write");
    const consumed = relay.consume("ABCDE");
    expect(consumed).not.toBeNull();
    expect(consumed).not.toBe("closed");
    if (consumed && consumed !== "closed") expect(consumed.requestId).toBe("abcde");
  });

  it("reports a second verdict for the same prompt as closed, not as a fresh one", () => {
    const { relay } = makeRelay();
    relay.add("abcde", "Bash");
    relay.consume("abcde");
    expect(relay.consume("abcde")).toBe("closed");
  });

  it("returns null for an id it never issued, so ordinary chat isn't eaten", () => {
    // "no problem" style messages must fall through to Claude as chat.
    const { relay } = makeRelay();
    relay.add("abcde", "Bash");
    expect(relay.consume("zzzzz")).toBeNull();
  });

  it("still auto-denies after a timeout, and treats a late verdict as closed", () => {
    const { relay, timedOut } = makeRelay();
    relay.add("abcde", "Bash");
    vi.advanceTimersByTime(TIMEOUT);
    expect(timedOut).toHaveLength(1);
    // A tap that lands after the prompt expired must not reach Claude as chat.
    expect(relay.consume("abcde")).toBe("closed");
  });

  describe("turn ended", () => {
    it("reports every prompt as retirable and marks them answered", () => {
      const { relay } = makeRelay();
      relay.add("aaaaa", "Bash");
      relay.add("bbbbb", "Write");

      const retirable = relay.markAllAnswered();
      expect(retirable.map((p) => p.requestId).sort()).toEqual(["aaaaa", "bbbbb"]);
      expect(retirable.every((p) => p.assumedAnswered)).toBe(true);
    });

    it("keeps the auto-deny armed — a wrong assumption must not strand the turn", () => {
      // If a turn could somehow end with a dialog genuinely still open, the
      // timeout is the only thing that resolves it. So it stays armed, and only
      // the misleading notice is suppressed.
      const { relay, timedOut } = makeRelay();
      relay.add("abcde", "Bash");
      relay.markAllAnswered();
      expect(relay.size).toBe(1);

      vi.advanceTimersByTime(TIMEOUT);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].assumedAnswered).toBe(true);
    });

    it("a verdict still wins after the turn was marked ended", () => {
      const { relay } = makeRelay();
      relay.add("abcde", "Bash");
      relay.markAllAnswered();
      expect(relay.consume("abcde")).toMatchObject({ requestId: "abcde" });
    });

    it("hands back the message id so the prompt can be retired", () => {
      const { relay } = makeRelay();
      relay.add("abcde", "Bash");
      relay.setMessageId("abcde", 4242);
      expect(relay.markAllAnswered()[0].messageId).toBe(4242);
    });

    it("is idempotent — /done fires per turn, not per message", () => {
      // Retiring twice would post the "prompt closed" note twice.
      const { relay } = makeRelay();
      relay.add("abcde", "Bash");
      expect(relay.markAllAnswered()).toHaveLength(1);
      expect(relay.markAllAnswered()).toHaveLength(0);
      expect(relay.markAllAnswered()).toHaveLength(0);
    });

    it("is a no-op when nothing is pending", () => {
      const { relay } = makeRelay();
      expect(relay.markAllAnswered()).toEqual([]);
    });

    it("reports promptRetired so the timeout doesn't re-announce it", () => {
      const { relay, timedOut } = makeRelay();
      relay.add("abcde", "Bash");
      relay.markAllAnswered();
      vi.advanceTimersByTime(TIMEOUT);
      expect(timedOut[0].promptRetired).toBe(true);
    });
  });

  describe("tool completed (suggestive, not proof)", () => {
    it("suppresses the misleading notice but keeps the safety net armed", () => {
      const { relay, timedOut } = makeRelay();
      relay.add("abcde", "Bash");
      const marked = relay.markToolCompleted("Bash");
      expect(marked).toMatchObject({ requestId: "abcde", assumedAnswered: true });

      // Crucially still pending: the buttons keep working and the timer stands.
      expect(relay.size).toBe(1);
      vi.advanceTimersByTime(TIMEOUT);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].assumedAnswered, "notice suppressed, deny still sent").toBe(true);
    });

    it("a verdict still wins after the tool was marked", () => {
      // The parallel-tools misfire case: another Bash finished, but THIS prompt
      // is genuinely still open, so the user's answer must still be honoured.
      const { relay } = makeRelay();
      relay.add("abcde", "Bash");
      relay.markToolCompleted("Bash");
      expect(relay.consume("abcde")).toMatchObject({ requestId: "abcde" });
    });

    it("ignores tools that don't match a pending prompt", () => {
      const { relay } = makeRelay();
      relay.add("abcde", "Bash");
      expect(relay.markToolCompleted("Write")).toBeNull();
      expect(relay.markToolCompleted("Bash")).not.toBeNull();
    });

    it("marks one prompt per completion when several share a tool name", () => {
      const { relay } = makeRelay();
      relay.add("aaaaa", "Bash");
      relay.add("bbbbb", "Bash");

      expect(relay.markToolCompleted("Bash")?.requestId).toBe("aaaaa");
      expect(relay.markToolCompleted("Bash")?.requestId).toBe("bbbbb");
      expect(relay.markToolCompleted("Bash")).toBeNull();
    });

    it("does nothing when there are no pending prompts at all", () => {
      // The overwhelmingly common case: every tool completion in a normal turn.
      const { relay } = makeRelay();
      expect(relay.markToolCompleted("Read")).toBeNull();
    });
  });

  it("bounds how many closed ids it remembers", () => {
    const { relay } = makeRelay();
    const id = (n: number) => `id${String(n).padStart(3, "0")}`;
    for (let i = 0; i < CLOSED_MEMORY + 5; i++) {
      relay.add(id(i), "Bash");
      relay.consume(id(i));
    }
    expect(relay.wasRecentlyClosed(id(CLOSED_MEMORY + 4))).toBe(true);
    expect(relay.wasRecentlyClosed(id(0)), "oldest ids fall out of the ring").toBe(false);
  });

  it("re-registering an id doesn't leave the first timer running", () => {
    const { relay, timedOut } = makeRelay();
    relay.add("abcde", "Bash");
    relay.add("abcde", "Write");
    vi.advanceTimersByTime(TIMEOUT);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].toolName).toBe("Write");
  });
});
