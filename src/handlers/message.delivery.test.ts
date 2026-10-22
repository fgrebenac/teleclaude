import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type Server } from "http";
import { sendToChannel, loopbackFetch } from "./message.js";

// sendToChannel persists activity via session-state. loadSessionState/etc are
// configDir-parameterized now, but this test doesn't thread a configDir
// through, so the real functions would still fall back to the REAL
// ~/.teleclaude/sessions.json. Mock the stateful functions, keep the pure
// ones (spawnSettingsFor) real — same pattern as scheduler.test.ts.
vi.mock("../session-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-state.js")>();
  return {
    ...actual,
    getTopicSession: vi.fn(() => undefined),
    updateTopicSession: vi.fn(),
  };
});

const CHAT = -100;
let nextTopic = 3000;

function fakePm(overrides: Record<string, unknown> = {}) {
  return {
    isRunning: vi.fn(() => true),
    getSpawnToken: vi.fn(() => "gen-1"),
    getChannelStatus: vi.fn(() => "registered" as const),
    getPort: vi.fn(() => 0),
    spawn: vi.fn(() => 0),
    kill: vi.fn(),
    beginTurn: vi.fn(() => ({ seq: 1, nonce: "n" })),
    getCurrentTurnToken: vi.fn(() => undefined),
    getLastToolUse: vi.fn(() => undefined),
    isDoneNotify: vi.fn(() => false),
    ...overrides,
  };
}

function fakeBot() {
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendChatAction: vi.fn(async () => ({})),
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve((server.address() as { port: number }).port);
  }));
}

function sentTexts(bot: ReturnType<typeof fakeBot>): string[] {
  return bot.api.sendMessage.mock.calls.map((c: any[]) => c[1] as string);
}

describe("sendToChannel — delivery failure notices", () => {
  let dir: string;
  let server: Server | undefined;
  let topicId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-delivery-"));
    topicId = nextTopic++; // fresh composite key per test — module-level maps persist
  });

  afterEach(() => {
    server?.close();
    server = undefined;
    rmSync(dir, { recursive: true });
  });

  it("notifies the topic when the channel rejects the POST (non-2xx) instead of failing silently", async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/ready") { res.writeHead(200).end("ok"); return; }
      res.writeHead(500).end("boom");
    });
    const port = await listen(server);
    const pm = fakePm({ getPort: vi.fn(() => port) });
    const bot = fakeBot();

    const result = await sendToChannel(CHAT, topicId, dir, "hello", pm as any, bot as any, dir);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HTTP 500");
    expect(sentTexts(bot).some((t) => t.includes("Failed to deliver your message"))).toBe(true);
    // An HTTP-level rejection is not the network-level failure the catch
    // branch kills for — the process stays up.
    expect(pm.kill).not.toHaveBeenCalled();
  });

  it("notifies the topic when a message was waiting on another message's spawn and that spawn failed", async () => {
    // isRunning stays false, so waitForReady sees the spawned process as
    // already dead ("died") on its first check — the spawn fails fast.
    const pm = fakePm({ isRunning: vi.fn(() => false), spawn: vi.fn(() => 4242) });
    const bot = fakeBot();

    // p1 runs synchronously up to `await readyPromise` (topicReady is set by
    // then); p2 then synchronously reaches the pending-spawn branch and waits.
    const p1 = sendToChannel(CHAT, topicId, dir, "first", pm as any, bot as any, dir);
    const p2 = sendToChannel(CHAT, topicId, dir, "second", pm as any, bot as any, dir);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    // The spawn's own notice (pre-existing) covers the message that triggered it…
    expect(sentTexts(bot).some((t) => t.includes("exited right after starting"))).toBe(true);
    // …and the waiter's message gets its own notice (this is the fix).
    expect(sentTexts(bot).some((t) => t.includes("failed to start, so your message wasn't delivered"))).toBe(true);
  });

  it("a throwing spawn does not kill whatever process currently owns the topic", async () => {
    const pm = fakePm({
      isRunning: vi.fn(() => false),
      spawn: vi.fn(() => { throw new Error("spawn boom"); }),
      // If the buggy bare kill ran, it would hit a process belonging to a
      // DIFFERENT generation — the exact invariant violation being fixed.
      getSpawnToken: vi.fn(() => "someone-elses-generation"),
    });
    const bot = fakeBot();

    const result = await sendToChannel(CHAT, topicId, dir, "hello", pm as any, bot as any, dir);

    expect(result.ok).toBe(false);
    expect(pm.kill).not.toHaveBeenCalled();
    expect(sentTexts(bot).some((t) => t.includes("failed to start"))).toBe(true);
  });
});

describe("loopbackFetch", () => {
  it("aborts a hung server instead of stalling forever", async () => {
    const hung = createServer(() => { /* never respond */ });
    const port = await listen(hung);
    try {
      const started = Date.now();
      await expect(loopbackFetch(`http://127.0.0.1:${port}/ready`, {}, 100)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      hung.close();
    }
  });
});
