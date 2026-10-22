import { describe, it, expect } from "vitest";
import { shouldPromptReview, parseReviewAction, reviewCallbackData } from "./review-prompt.js";

describe("shouldPromptReview", () => {
  it("prompts only when review is on AND there are changes", () => {
    expect(shouldPromptReview(true, true)).toBe(true);
    expect(shouldPromptReview(true, false)).toBe(false);
    expect(shouldPromptReview(false, true)).toBe(false);
    expect(shouldPromptReview(false, false)).toBe(false);
  });
});

describe("parseReviewAction / reviewCallbackData round-trip", () => {
  it("parses a well-formed diff payload with a negative chat id", () => {
    expect(parseReviewAction("review:diff:-1001999:42")).toEqual({ verb: "diff", chatId: -1001999, topicId: 42 });
  });

  it("parses leave", () => {
    expect(parseReviewAction("review:leave:-100:7")).toEqual({ verb: "leave", chatId: -100, topicId: 7 });
  });

  it("parses commit", () => {
    expect(parseReviewAction("review:commit:-100:7")).toEqual({ verb: "commit", chatId: -100, topicId: 7 });
  });

  it("rejects non-review or malformed payloads", () => {
    expect(parseReviewAction("cancelturn:5:9")).toBeNull();
    expect(parseReviewAction("review:squash:-1:2")).toBeNull(); // unknown verb
    expect(parseReviewAction("review:diff:abc:2")).toBeNull();
    expect(parseReviewAction("review:diff:-1:2:extra")).toBeNull();
  });

  it("round-trips through reviewCallbackData", () => {
    const data = reviewCallbackData("diff", -1002, 88);
    expect(parseReviewAction(data)).toEqual({ verb: "diff", chatId: -1002, topicId: 88 });
  });
});
