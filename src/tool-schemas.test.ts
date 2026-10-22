import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  androidActionSchema, androidShape, askQuestionSchema, askUserShape, browseActionSchema, browseShape,
  iosActionSchema, iosShape, replyShape, screenshotShape, sendFileShape, sendPageShape,
} from "./tool-schemas.js";
import type { AndroidAction } from "./android.js";
import type { IosAction } from "./ios.js";
import type { BrowseAction } from "./screenshot.js";
import type { AskQuestionInput } from "./ask-relay.js";
import type { SendPageInput } from "./page-render.js";

/**
 * Compile-time guard: a parsed action must be usable as the module's own type
 * without a cast. If either side drifts, this stops building — which is the
 * whole point of moving off hand-written JSON Schema.
 */
const _androidAssignable: AndroidAction = androidActionSchema.parse({ action: "tap", x: 1, y: 2 });
const _iosAssignable: IosAction = iosActionSchema.parse({ action: "launch", bundleId: "com.x" });
const _browseAssignable: BrowseAction = browseActionSchema.parse({ action: "goto", url: "http://x" });
const _askQuestionAssignable: AskQuestionInput = askQuestionSchema.parse({
  question: "Which library?", options: [{ label: "React Query" }, { label: "SWR" }],
});
const _sendPageAssignable: SendPageInput = {} as z.infer<z.ZodObject<typeof sendPageShape>>;
void _androidAssignable; void _iosAssignable; void _browseAssignable; void _askQuestionAssignable; void _sendPageAssignable;

describe("androidActionSchema", () => {
  it("accepts every action in its documented form", () => {
    const valid: unknown[] = [
      { action: "launch" },
      { action: "launch", avd: "Pixel_7" },
      { action: "install", apk: "/tmp/app.apk" },
      { action: "open", url: "https://example.com" },
      { action: "screenshot" },
      { action: "tap", x: 10, y: 20 },
      { action: "swipe", x1: 0, y1: 0, x2: 5, y2: 5 },
      { action: "swipe", x1: 0, y1: 0, x2: 5, y2: 5, duration: 500 },
      { action: "type", text: "hello" },
      { action: "key", keycode: "BACK" },
      { action: "shell", command: "pm list packages" },
      { action: "wait", seconds: 2 },
    ];
    for (const v of valid) {
      expect(androidActionSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
    }
  });

  it("rejects install without an apk — the bug the old schema allowed through", () => {
    // The hand-written JSON Schema marked every field optional with only
    // `action` required, so this passed validation and failed inside adb.
    const result = androidActionSchema.safeParse({ action: "install" });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain("apk");
  });

  it("rejects a tap missing a coordinate", () => {
    expect(androidActionSchema.safeParse({ action: "tap", x: 10 }).success).toBe(false);
    expect(androidActionSchema.safeParse({ action: "tap" }).success).toBe(false);
  });

  it("rejects a swipe missing an endpoint", () => {
    expect(androidActionSchema.safeParse({ action: "swipe", x1: 0, y1: 0, x2: 5 }).success).toBe(false);
  });

  it("rejects unknown actions instead of passing them to adb", () => {
    expect(androidActionSchema.safeParse({ action: "reboot" }).success).toBe(false);
  });

  it("rejects wrongly-typed coordinates", () => {
    expect(androidActionSchema.safeParse({ action: "tap", x: "10", y: "20" }).success).toBe(false);
  });
});

describe("iosActionSchema", () => {
  it("accepts every action in its documented form", () => {
    const valid: unknown[] = [
      { action: "boot" },
      { action: "boot", udid: "ABC-123" },
      { action: "install", ipa: "/tmp/app.ipa" },
      { action: "launch", bundleId: "com.example.app" },
      { action: "open", url: "https://example.com" },
      { action: "screenshot" },
      { action: "tap", x: 1, y: 2 },
      { action: "swipe", x1: 0, y1: 0, x2: 1, y2: 1 },
      { action: "type", text: "hi" },
      { action: "key", keycode: "HOME" },
      { action: "shell", command: "ls" },
      { action: "wait", seconds: 1 },
    ];
    for (const v of valid) {
      expect(iosActionSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
    }
  });

  it("requires bundleId to launch and ipa to install", () => {
    expect(iosActionSchema.safeParse({ action: "launch" }).success).toBe(false);
    expect(iosActionSchema.safeParse({ action: "install" }).success).toBe(false);
  });

  it("keeps udid optional on boot (auto-detects the first simulator)", () => {
    expect(iosActionSchema.safeParse({ action: "boot" }).success).toBe(true);
  });
});

describe("browseActionSchema", () => {
  it("stays loose on purpose — browse soft-fails per action and runs the rest", () => {
    // Tightening this would turn one malformed step into a rejected batch,
    // losing the partial-execution behaviour and the final screenshot.
    expect(browseActionSchema.safeParse({ action: "goto" }).success).toBe(true);
    expect(browseActionSchema.safeParse({ action: "click" }).success).toBe(true);
  });

  it("still rejects an action it has no handler for", () => {
    expect(browseActionSchema.safeParse({ action: "teleport" }).success).toBe(false);
  });

  it("constrains scroll direction to the two the implementation handles", () => {
    expect(browseActionSchema.safeParse({ action: "scroll", direction: "up" }).success).toBe(true);
    expect(browseActionSchema.safeParse({ action: "scroll", direction: "sideways" }).success).toBe(false);
  });
});

describe("tool input shapes", () => {
  it("require a non-empty actions list rather than silently doing nothing", () => {
    for (const shape of [browseShape, androidShape, iosShape]) {
      expect(z.object(shape).safeParse({ actions: [] }).success).toBe(false);
    }
  });

  it("offer return_image on every tool that produces a screenshot", () => {
    for (const shape of [screenshotShape, browseShape, androidShape, iosShape]) {
      expect("return_image" in shape).toBe(true);
      // Optional: the default has to stay "don't spend context on an image".
      expect(z.object(shape as never).safeParse(
        shape === screenshotShape ? { url: "http://x" } : { actions: [{ action: "screenshot" }] },
      ).success).toBe(true);
    }
  });

  it("keeps both text and message optional on reply", () => {
    // Neither can be required: `message` exists because Claude has been seen
    // calling with a stale schema, and rejecting that would cost a reply.
    const parsed = z.object(replyShape).safeParse({ message: "hi" });
    expect(parsed.success).toBe(true);
    expect(z.object(replyShape).safeParse({ text: "hi" }).success).toBe(true);
    // The handler is what rejects the empty case, with an isError result.
    expect(z.object(replyShape).safeParse({}).success).toBe(true);
  });

  it("requires a non-empty file_path for send_file", () => {
    expect(z.object(sendFileShape).safeParse({ file_path: "" }).success).toBe(false);
    expect(z.object(sendFileShape).safeParse({}).success).toBe(false);
    expect(z.object(sendFileShape).safeParse({ file_path: "/tmp/x" }).success).toBe(true);
  });

  it("send_page requires title and content", () => {
    const schema = z.object(sendPageShape);
    expect(schema.safeParse({ title: "t", content: "c" }).success).toBe(true);
    expect(schema.safeParse({ title: "t" }).success).toBe(false);
    expect(schema.safeParse({ content: "c" }).success).toBe(false);
  });

  it("requires a url for screenshot", () => {
    expect(z.object(screenshotShape).safeParse({}).success).toBe(false);
    expect(z.object(screenshotShape).safeParse({ url: "http://localhost:3000" }).success).toBe(true);
  });

  it("does not demand a scheme on the screenshot url", () => {
    // takeScreenshot handles bare hosts; over-validating here would reject calls
    // that used to work.
    expect(z.object(screenshotShape).safeParse({ url: "localhost:3000" }).success).toBe(true);
  });
});

describe("askQuestionSchema / askUserShape", () => {
  it("accepts a well-formed single- and multi-select question", () => {
    expect(askQuestionSchema.safeParse({
      question: "Which library?", header: "Library",
      options: [{ label: "React Query", description: "Recommended" }, { label: "SWR" }],
    }).success).toBe(true);
    expect(askQuestionSchema.safeParse({
      question: "Which environments?", multiSelect: true,
      options: [{ label: "dev" }, { label: "staging" }, { label: "prod" }],
    }).success).toBe(true);
  });

  it("requires 2-4 options", () => {
    expect(askQuestionSchema.safeParse({ question: "Q?", options: [{ label: "only one" }] }).success).toBe(false);
    expect(askQuestionSchema.safeParse({ question: "Q?", options: [] }).success).toBe(false);
    const fiveOptions = Array.from({ length: 5 }, (_, i) => ({ label: `opt${i}` }));
    expect(askQuestionSchema.safeParse({ question: "Q?", options: fiveOptions }).success).toBe(false);
  });

  it("bounds question/label/description length so an oversized call fails fast, not 5 minutes later", () => {
    expect(askQuestionSchema.safeParse({
      question: "x".repeat(501), options: [{ label: "a" }, { label: "b" }],
    }).success).toBe(false);
    expect(askQuestionSchema.safeParse({
      question: "Q?", options: [{ label: "x".repeat(101) }, { label: "b" }],
    }).success).toBe(false);
    expect(askQuestionSchema.safeParse({
      question: "Q?", options: [{ label: "a", description: "x".repeat(501) }, { label: "b" }],
    }).success).toBe(false);
  });

  it("requires at least one question and caps the batch at 4", () => {
    expect(z.object(askUserShape).safeParse({ questions: [] }).success).toBe(false);
    const q = { question: "Q?", options: [{ label: "a" }, { label: "b" }] };
    expect(z.object(askUserShape).safeParse({ questions: [q, q, q, q] }).success).toBe(true);
    expect(z.object(askUserShape).safeParse({ questions: [q, q, q, q, q] }).success).toBe(false);
  });
});
