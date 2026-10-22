// src/telegram-errors.test.ts
import { describe, expect, it } from "vitest";
import { TelegramApiError, classifyTelegramError } from "./telegram-errors.js";

describe("classifyTelegramError", () => {
  it("classifies 429 as rate-limit", () => {
    const err = new TelegramApiError("sendMessage", "Too Many Requests: retry after 5", 429, 5);
    expect(classifyTelegramError(err)).toBe("rate-limit");
    expect(err.retryAfter).toBe(5);
  });
  it("classifies entity parse failures", () => {
    expect(classifyTelegramError(new TelegramApiError("sendMessage",
      "Bad Request: can't parse entities: Unsupported start tag \"a href=\" at byte offset 4", 400))).toBe("parse");
  });
  it("classifies not-modified edits", () => {
    expect(classifyTelegramError(new TelegramApiError("editMessageText",
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same", 400))).toBe("not-modified");
  });
  it("classifies too-long", () => {
    expect(classifyTelegramError(new TelegramApiError("sendMessage",
      "Bad Request: message is too long", 400))).toBe("too-long");
  });
  it("classifies wrapped network failures (status 0)", () => {
    expect(classifyTelegramError(new TelegramApiError("sendMessage", "fetch failed", 0))).toBe("network");
  });
  it("classifies unknown API rejections and foreign errors as other", () => {
    expect(classifyTelegramError(new TelegramApiError("sendMessage", "Bad Request: chat not found", 400))).toBe("other");
    expect(classifyTelegramError(new TypeError("boom"))).toBe("other");
  });
});
