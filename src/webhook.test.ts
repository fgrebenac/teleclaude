import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const sendToChannel = vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
vi.mock("./handlers/message.js", () => ({ sendToChannel }));

const {
  loadWebhooks, setWebhook, removeWebhook, getWebhook, newWebhookToken,
  findByToken, tokensMatch, RateLimiter, parseWebhookBody, handleWebhookRequest,
  clearWebhookCache, MAX_WEBHOOK_BODY_BYTES,
} = await import("./webhook.js");
const { saveProjects, clearConfigCache } = await import("./config.js");

const CHAT = -1001;
const TOPIC = 7;

function entry(token: string) {
  return { token, chatId: CHAT, topicId: TOPIC, project: "P", createdAt: 0, createdBy: 1 };
}

function fakeReq(headers: Record<string, string>, body: string, method = "POST") {
  return {
    method,
    headers,
    resume: () => {},
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  } as any;
}

function fakeRes() {
  const out = { status: 0, body: "" };
  const res = {
    out,
    writeHead(status: number) { out.status = status; return res; },
    end(b?: string) { out.body = b ?? ""; },
  };
  return res as any;
}

function fakeBot() {
  const sent: Array<{ chatId: number; text: string }> = [];
  return { sent, api: { sendMessage: vi.fn(async (chatId: number, text: string) => { sent.push({ chatId, text }); }) } } as any;
}

describe("webhook store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-webhook-"));
  });

  afterEach(() => {
    clearWebhookCache();
    clearConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips and replaces per (chat, topic)", () => {
    setWebhook(entry("tok-a"), dir);
    expect(getWebhook(CHAT, TOPIC, dir)?.token).toBe("tok-a");
    setWebhook(entry("tok-b"), dir);
    expect(loadWebhooks(dir).hooks).toHaveLength(1);
    expect(getWebhook(CHAT, TOPIC, dir)?.token).toBe("tok-b");
    expect(removeWebhook(CHAT, TOPIC, dir)).toBe(true);
    expect(getWebhook(CHAT, TOPIC, dir)).toBeUndefined();
    expect(removeWebhook(CHAT, TOPIC, dir)).toBe(false);
  });
});

describe("token matching", () => {
  it("matches only the exact token", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    const hooks = [entry("tok-a"), { ...entry("tok-b"), topicId: 8 }];
    expect(findByToken(hooks, "tok-b")?.topicId).toBe(8);
    expect(findByToken(hooks, "nope")).toBeNull();
  });

  it("generates distinct, prefixed tokens", () => {
    const a = newWebhookToken();
    expect(a.startsWith("tw_")).toBe(true);
    expect(a).not.toBe(newWebhookToken());
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("RateLimiter", () => {
  it("allows max hits per window, then recovers", () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.allow("k", 0)).toBe(true);
    expect(rl.allow("k", 1)).toBe(true);
    expect(rl.allow("k", 2)).toBe(false);
    expect(rl.allow("other", 2)).toBe(true);
    expect(rl.allow("k", 60_001)).toBe(true);
  });
});

describe("parseWebhookBody", () => {
  it("accepts {message} and rejects everything else", () => {
    expect(parseWebhookBody('{"message":"hi"}')).toEqual({ ok: true, message: "hi" });
    expect(parseWebhookBody("{}").ok).toBe(false);
    expect(parseWebhookBody('{"message":"  "}').ok).toBe(false);
    expect(parseWebhookBody("not json").ok).toBe(false);
    expect(parseWebhookBody(`{"message":"${"x".repeat(4001)}"}`).ok).toBe(false);
  });
});

describe("handleWebhookRequest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-webhook-req-"));
    saveProjects({ projects: [{ name: "P", path: "/tmp/p", chatId: CHAT, topicId: TOPIC, createdAt: "" }] }, dir);
    sendToChannel.mockClear();
  });

  afterEach(() => {
    clearWebhookCache();
    clearConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a missing or unknown token with 401", async () => {
    setWebhook(entry("tok-real"), dir);
    const res1 = fakeRes();
    await handleWebhookRequest(fakeReq({}, '{"message":"x"}'), res1, fakeBot(), {} as any, dir);
    expect(res1.out.status).toBe(401);
    const res2 = fakeRes();
    await handleWebhookRequest(fakeReq({ "x-teleclaude-webhook-token": "wrong" }, '{"message":"x"}'), res2, fakeBot(), {} as any, dir);
    expect(res2.out.status).toBe(401);
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it("accepts a valid request with 202 and delivers through sendToChannel", async () => {
    setWebhook(entry("tok-good"), dir);
    const bot = fakeBot();
    const res = fakeRes();
    await handleWebhookRequest(fakeReq({ "x-teleclaude-webhook-token": "tok-good" }, '{"message":"deploy done"}'), res, bot, {} as any, dir);
    expect(res.out.status).toBe(202);
    await vi.waitFor(() => expect(sendToChannel).toHaveBeenCalled());
    expect(bot.sent.some((s: any) => s.text === "🪝 deploy done")).toBe(true);
    expect(sendToChannel.mock.calls[0].slice(0, 4)).toEqual([CHAT, TOPIC, "/tmp/p", "deploy done"]);
  });

  it("rejects an oversized body with 413", async () => {
    setWebhook(entry("tok-big"), dir);
    const res = fakeRes();
    const huge = `{"message":"${"y".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`;
    await handleWebhookRequest(fakeReq({ "x-teleclaude-webhook-token": "tok-big" }, huge), res, fakeBot(), {} as any, dir);
    expect(res.out.status).toBe(413);
  });

  it("answers 410 when the project no longer exists", async () => {
    setWebhook({ ...entry("tok-gone"), topicId: 999 }, dir);
    const res = fakeRes();
    await handleWebhookRequest(fakeReq({ "x-teleclaude-webhook-token": "tok-gone" }, '{"message":"x"}'), res, fakeBot(), {} as any, dir);
    expect(res.out.status).toBe(410);
  });

  it("rejects non-POST with 405", async () => {
    const res = fakeRes();
    await handleWebhookRequest(fakeReq({}, "", "GET"), res, fakeBot(), {} as any, dir);
    expect(res.out.status).toBe(405);
  });
});
