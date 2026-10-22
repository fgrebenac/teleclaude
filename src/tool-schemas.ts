/**
 * Input schemas for the channel server's MCP tools.
 *
 * These replace ~150 lines of hand-written JSON Schema that had to be kept in
 * sync with the TypeScript types by hand, and drifted: the android/ios schemas
 * declared every field optional with only `action` required, while their action
 * types are discriminated unions where `install` needs an apk and `tap` needs
 * coordinates. So `{action:"install"}` passed validation and failed inside adb,
 * and the call handler had to cast unvalidated input (`args.actions as
 * AndroidAction[]`) to get any types at all.
 *
 * Each schema here mirrors the exported TS type for its module, so a parsed
 * value is assignable to it with no cast (tool-schemas.test.ts asserts that at
 * compile time). The SDK derives the JSON Schema Claude sees from these, so the
 * requirements are now *documented* to the model rather than discovered by
 * failing.
 */
import { z } from "zod";

/** Shared across every tool that produces a screenshot. */
const returnImage = z
  .boolean()
  .optional()
  .describe(
    "Also return the final screenshot to you as an image so you can see it yourself. " +
      "Set true when the pixels drive your next decision (where to tap, did the page render, is the layout broken). " +
      "Leave false when you're only showing the user. Costs context, so don't set it by default.",
  );

// --- reply / send_file ---

export const replyShape = {
  // `text` is what the schema advertises. `message` is tolerated because Claude
  // has been observed calling with a stale schema, and rejecting that call would
  // silently cost the user a reply. Neither can be required for that reason; the
  // handler rejects a call that supplies no text at all.
  text: z.string().optional().describe("The message text to send"),
  message: z.string().optional().describe("Alias for text (accepted for compatibility)"),
};

export const sendFileShape = {
  file_path: z.string().min(1).describe("Path to the file to send — must be inside the project directory (relative paths resolve against it)"),
};

export const sendPageShape = {
  title: z.string().min(1).max(200).describe("Page title — shown as the document heading and used for the filename"),
  content: z.string().min(1).describe("Markdown body (GFM: tables, fenced code, lists). Inline HTML passes through for special layouts. Max 2MB. Start with body content — the title is already rendered as the page heading, do not repeat it as an H1."),
  filename: z.string().min(1).max(80).optional().describe("Optional filename stem override (slugged; '.html' appended automatically)"),
};

// --- screenshot / browse ---

export const screenshotShape = {
  url: z.string().min(1).describe("URL to screenshot (e.g. http://localhost:3000)"),
  full_page: z.boolean().optional().describe("Capture full page (not just viewport). Default: false"),
  return_image: returnImage,
};

/**
 * Mirrors `BrowseAction`: one loose shape rather than a discriminated union,
 * because `browse` validates per action at runtime and logs a failure for that
 * step while still running the rest of the sequence. Tightening this would turn
 * one malformed step into a rejected batch.
 */
export const browseActionSchema = z.object({
  action: z.enum(["goto", "click", "type", "wait", "screenshot", "scroll", "select"]),
  url: z.string().optional().describe("URL for goto"),
  selector: z.string().optional().describe("CSS selector for click/type/select"),
  text: z.string().optional().describe("Text to type, or value to select"),
  seconds: z.number().optional().describe("Seconds to wait (for wait)"),
  direction: z.enum(["up", "down"]).optional().describe("Scroll direction"),
  pixels: z.number().optional().describe("Pixels to scroll (default 500)"),
});

export const browseShape = {
  actions: z.array(browseActionSchema).min(1).describe("Sequence of browser actions, executed in order"),
  return_image: returnImage,
};

// --- android / ios ---

const swipe = {
  x1: z.number().describe("Start X"),
  y1: z.number().describe("Start Y"),
  x2: z.number().describe("End X"),
  y2: z.number().describe("End Y"),
  duration: z.number().optional().describe("Swipe duration ms (default 300)"),
};

/** Mirrors `AndroidAction` — a discriminated union, so per-action requirements hold. */
export const androidActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("launch"), avd: z.string().optional().describe("AVD name (defaults to the first available)") }),
  z.object({ action: z.literal("install"), apk: z.string().describe("Absolute path to the APK") }),
  z.object({ action: z.literal("open"), url: z.string().describe("URL to open") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({ action: z.literal("swipe"), ...swipe }),
  z.object({ action: z.literal("type"), text: z.string() }),
  z.object({ action: z.literal("key"), keycode: z.string().describe("Android keycode: BACK, HOME, ENTER, …") }),
  z.object({ action: z.literal("shell"), command: z.string() }),
  z.object({ action: z.literal("wait"), seconds: z.number() }),
]);

export const androidShape = {
  actions: z.array(androidActionSchema).min(1).describe("Sequence of Android actions, executed in order"),
  serial: z.string().optional().describe("Emulator serial (e.g. emulator-5554). Auto-detected if omitted."),
  return_image: returnImage,
};

/** Mirrors `IosAction`. Same union treatment as Android. */
export const iosActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("boot"), udid: z.string().optional().describe("Simulator UDID (defaults to the first available iPhone)") }),
  z.object({ action: z.literal("install"), ipa: z.string().describe("Absolute path to the IPA") }),
  z.object({ action: z.literal("launch"), bundleId: z.string().describe("App bundle id (e.g. com.example.app)") }),
  z.object({ action: z.literal("open"), url: z.string().describe("URL to open") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({ action: z.literal("swipe"), ...swipe }),
  z.object({ action: z.literal("type"), text: z.string() }),
  z.object({ action: z.literal("key"), keycode: z.string().describe("Button: HOME, LOCK, SIRI, SIDE_BUTTON") }),
  z.object({ action: z.literal("shell"), command: z.string() }),
  z.object({ action: z.literal("wait"), seconds: z.number() }),
]);

export const iosShape = {
  actions: z.array(iosActionSchema).min(1).describe("Sequence of iOS simulator actions, executed in order"),
  udid: z.string().optional().describe("Simulator UDID to target. Auto-detected (first booted) if omitted."),
  return_image: returnImage,
};

// --- ask_user ---

/**
 * Mirrors `AskOption` in ask-relay.ts. Bounds are generous but real: Telegram
 * caps a message at 4096 chars, and a single question renders as one message
 * (up to 4 options, each label + description) — without a cap here, a
 * pathological call would only fail at send time, 5 minutes later when the
 * unanswerable prompt times out, instead of at the tool-call boundary.
 */
export const askOptionSchema = z.object({
  label: z.string().min(1).max(100).describe("Short option label shown on the button (a few words)"),
  description: z.string().max(500).optional().describe("Longer explanation shown above the buttons"),
});

/** Mirrors `AskQuestionInput` in ask-relay.ts. */
export const askQuestionSchema = z.object({
  question: z.string().min(1).max(500).describe("The question to ask the user"),
  header: z.string().max(30).optional().describe("Short topic label for this question, shown as a chip (a few words)"),
  options: z.array(askOptionSchema).min(2).max(4).describe("2-4 choices"),
  multiSelect: z.boolean().optional().describe("Allow picking more than one option"),
});

export const askUserShape = {
  questions: z.array(askQuestionSchema).min(1).max(4).describe(
    "One or more multiple-choice questions for the user. Answered one at a time in Telegram (with tappable buttons); if more than one question is given, they're asked in sequence.",
  ),
};
