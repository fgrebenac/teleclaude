import { describe, it, expect } from "vitest";
import { awaitsPromptConfirmation, classifyChannelLine, promptConfirmKeys } from "./channel-detect.js";

// Workspace-trust dialog as Claude Code 2.1.301 renders it into the PTY scan
// buffer (ANSI stripped, TUI-eaten spaces) — "No, exit" listed first and selected.
const TRUST_DIALOG_2_1_301 = [
  "Accessingworkspace:",
  "/Users/alice/Work/sandbox",
  "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensource",
  "project,orworkfromyourteam).Ifnot,takeamomenttoreviewwhat'sinthisfolderfirst.",
  "ClaudeCode'llbeabletoread,edit,andexecutefileshere.",
  "Security guide",
  "❯No,exit",
  "Yes,Itrustthisfolder",
  "Entertoconfirm·Esctocancel",
].join("\n");

describe("classifyChannelLine", () => {
  it("detects the org-policy block from the startup banner", () => {
    // Real line from /tmp/teleclaude.log on the night channels were disabled.
    const line =
      "╯▎--dangerously-load-development-channels blocked by org policy (server:teleclaude-channel)▎Inbound messages will be silently dropped▎Have an administrator set channelsEnabled: true in managed settings to enable";
    expect(classifyChannelLine(line)).toBe("blocked");
  });

  it("detects the 'Channels are not enabled' notice", () => {
    const line =
      "Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings";
    expect(classifyChannelLine(line)).toBe("blocked");
  });

  it("detects the 'silently dropped' warning on its own", () => {
    expect(classifyChannelLine("Inbound messages will be silently dropped")).toBe("blocked");
  });

  it("detects the success confirmation", () => {
    const line =
      "Channels (experimental) messages from server:teleclaude-channel inject directly in this session · restart without --dangerously-load-development-channels to stop";
    expect(classifyChannelLine(line)).toBe("registered");
  });

  it("detects banners whose spaces were eaten by TUI rendering", () => {
    // ANSI-stripped TUI output concatenates words (observed in real PTY logs:
    // "WARNING:Loadingdevelopmentchannels...").
    expect(classifyChannelLine("--dangerously-load-development-channelsblockedbyorgpolicy(server:teleclaude-channel)")).toBe("blocked");
    expect(classifyChannelLine("Inboundmessageswillbesilentlydropped")).toBe("blocked");
    expect(classifyChannelLine("messagesfromserver:teleclaude-channelinjectdirectlyinthissession")).toBe("registered");
  });

  it("detects a rejected --resume", () => {
    // Real line from the Recipes topic on 2026-08-03: the transcript had been
    // swept by cleanupPeriodDays while the id lived on in sessions.json.
    expect(classifyChannelLine("No conversation found with session ID: 1683c6eb-684a-4b96-8fcd-1e0e716fb3d8"))
      .toBe("session-missing");
    // Same line after the TUI ate its spaces.
    expect(classifyChannelLine("NoconversationfoundwithsessionID:1683c6eb-684a-4b96-8fcd-1e0e716fb3d8"))
      .toBe("session-missing");
  });

  it("returns null for ordinary output", () => {
    expect(classifyChannelLine("⏺ Reading: processes.ts")).toBeNull();
    expect(classifyChannelLine("Cooked for 5s")).toBeNull();
    expect(classifyChannelLine("")).toBeNull();
  });

  it("does not misclassify the block notice as registered", () => {
    // Contains "Channels" but must be blocked, not registered.
    expect(classifyChannelLine("Channels are not enabled for your org")).toBe("blocked");
  });
});

describe("awaitsPromptConfirmation", () => {
  it("matches the affordance every startup dialog prints", () => {
    expect(awaitsPromptConfirmation("Enter to confirm · Esc to cancel")).toBe(true);
  });

  it("matches it with the spaces eaten, as the TUI renders it", () => {
    // Real captured form from the log: ANSI-stripped TUI output loses spaces.
    expect(awaitsPromptConfirmation("Entertoconfirm·Esctocancel")).toBe(true);
  });

  it("matches the real dev-channels dialog block", () => {
    const captured = [
      "WARNING:Loadingdevelopmentchannels",
      "Channels:server:teleclaude-channel",
      "❯1.Iamusingthisforlocaldevelopment",
      "2.Exit",
      "Entertoconfirm·Esctocancel",
    ].join("\n");
    expect(awaitsPromptConfirmation(captured)).toBe(true);
  });

  it("matches a workspace trust prompt on its own wording", () => {
    // The dialog most likely to appear for a brand-new project directory.
    expect(awaitsPromptConfirmation("Do you trust the files in this folder?")).toBe(true);
    expect(awaitsPromptConfirmation("Doyoutrustthisfolder?")).toBe(true);
  });

  it("ignores ordinary startup output", () => {
    for (const line of [
      "Channels (experimental) messages from server:teleclaude-channel inject directly",
      "⏵⏵ auto mode on (shift+tab to cycle)",
      "No conversation found with session ID: abc",
      "",
    ]) {
      expect(awaitsPromptConfirmation(line), line).toBe(false);
    }
  });

  it("does not fire on a dialog that was already dismissed", () => {
    // Post-confirmation echo: the chosen option, without the affordance line.
    expect(awaitsPromptConfirmation("I am using this for local development✔")).toBe(false);
  });

  it("matches the 2.1.301 trust dialog", () => {
    expect(awaitsPromptConfirmation(TRUST_DIALOG_2_1_301)).toBe(true);
    expect(awaitsPromptConfirmation("❯ No, exit\n  Yes, I trust this folder")).toBe(true);
  });
});

describe("promptConfirmKeys", () => {
  it("moves off a highlighted 'No, exit' to 'Yes, I trust this folder' before Enter", () => {
    expect(promptConfirmKeys(TRUST_DIALOG_2_1_301)).toEqual(["\x1b[B", "\r"]);
  });

  it("just presses Enter when Yes is already highlighted", () => {
    const yesSelected = TRUST_DIALOG_2_1_301.replace("❯No,exit", "No,exit").replace("Yes,Itrust", "❯Yes,Itrust");
    expect(promptConfirmKeys(yesSelected)).toEqual(["\r"]);
  });

  it("reads the latest redraw, not an earlier one", () => {
    const redrawnAfterDown = TRUST_DIALOG_2_1_301 + "\nNo,exit\n❯Yes,Itrustthisfolder\nEntertoconfirm·Esctocancel";
    expect(promptConfirmKeys(redrawnAfterDown)).toEqual(["\r"]);
  });

  it("just presses Enter for the dev-channels dialog", () => {
    const devChannels = "❯ I am using this for local development\n  Exit\nEnter to confirm · Esc to cancel";
    expect(promptConfirmKeys(devChannels)).toEqual(["\r"]);
  });

  it("never navigates on a 'No' option outside the trust dialog", () => {
    expect(promptConfirmKeys("❯ No\n  Yes\nEnter to confirm · Esc to cancel")).toEqual(["\r"]);
  });
});
