/**
 * Classify a line of Claude Code PTY output for channel registration state.
 *
 * teleclaude's whole message path depends on the channel MCP server being
 * registered. When the org disables channels (`channelsEnabled` off), Claude
 * Code prints an org-policy block and *silently drops* inbound messages — the
 * MCP HTTP port still binds, so a naive `/ready` check looks healthy while
 * nothing actually reaches Claude. We detect both the block and the success
 * confirmation straight from the PTY so the daemon can tell the user instead of
 * leaving them in the dark.
 *
 * Also recognizes a rejected `--resume`, which is not about channels at all but
 * shows up in the same startup output and is fatal: Claude Code exits immediately,
 * so naming the cause in the log beats inferring it from an exit code.
 *
 * Returns "blocked" / "registered" / "session-missing" for a recognized line, or
 * null otherwise.
 */
export type ChannelLineClass = "blocked" | "registered" | "session-missing" | null;

export function classifyChannelLine(line: string): ChannelLineClass {
  // ANSI-stripped TUI output loses its spaces ("blockedbyorgpolicy"), while
  // pre-TUI stdout keeps them — normalize both sides so either form matches.
  const s = line.replace(/\s+/g, "").toLowerCase();
  // Org-policy block. Any of these strings means messages won't be delivered:
  //   "--dangerously-load-development-channels blocked by org policy (...)"
  //   "Channels are not enabled for your org · have an administrator set channelsEnabled: true"
  //   "Inbound messages will be silently dropped"
  if (
    s.includes("blockedbyorgpolicy") ||
    s.includes("channelsarenotenabled") ||
    s.includes("inboundmessageswillbesilentlydropped")
  ) {
    return "blocked";
  }
  // Rejected --resume:
  //   "No conversation found with session ID: 1683c6eb-..."
  // The transcript was deleted (retention sweep) while the id lived on in
  // sessions.json. Claude Code exits code=1 right after printing this.
  if (s.includes("noconversationfoundwithsessionid")) return "session-missing";
  // Success confirmation:
  //   "Channels (experimental) messages from server:... inject directly in this session"
  // NOTE: current Claude Code versions never print this — the authoritative
  // "registered" signal is the first token-valid hook (daemon → ProcessManager.
  // markChannelRegistered). This match is kept for versions that do print it.
  if (s.includes("injectdirectly")) return "registered";
  return null;
}

/**
 * Whether the PTY is currently sitting on a dialog waiting for Enter.
 *
 * Spawn has to clear startup dialogs with nobody at the keyboard: a workspace
 * trust prompt for a directory Claude Code hasn't seen before, then the
 * development-channels warning. That was done with blind Enters on a 2s/4s timer,
 * which is a bet on render timing — too early and the keystroke lands before the
 * dialog exists, and a third dialog would never be answered at all.
 *
 * Rather than enumerate dialogs, match the affordance every one of them prints
 * ("Enter to confirm · Esc to cancel"), so an unfamiliar prompt still gets
 * answered. The specific trust wording is matched too, since it's the dialog most
 * likely to appear on a brand-new project directory.
 *
 * Which key answers it is `promptConfirmKeys`' job: Enter takes the highlighted
 * option, which is not always the one teleclaude needs. Callers must bound how
 * often they act on this (the TUI re-renders the same dialog many times) and
 * only during startup.
 */
export function awaitsPromptConfirmation(text: string): boolean {
  const s = text.replace(/\s+/g, "").toLowerCase();
  return (
    s.includes("entertoconfirm") ||
    s.includes("doyoutrustthefiles") ||
    s.includes("doyoutrustthisfolder") ||
    s.includes("itrustthisfolder")
  );
}

const KEY_DOWN = "\x1b[B";

/**
 * Keystrokes that accept the startup dialog on screen.
 *
 * Usually just Enter. But since Claude Code 2.1.301 the workspace-trust dialog
 * ("Quick safety check: Is this a project you created or one you trust?") lists
 * "No, exit" first and highlights it, so Enter alone declines and Claude Code
 * exits with code 1. When the highlighted (❯) option is a "No" and a
 * "Yes, I trust this folder" option is on screen, move down to it first.
 */
export function promptConfirmKeys(text: string): string[] {
  const s = text.replace(/\s+/g, "").toLowerCase();
  const selected = s.lastIndexOf("❯");
  if (selected !== -1 && s.startsWith("no", selected + 1) && s.includes("yes,itrust")) {
    return [KEY_DOWN, "\r"];
  }
  return ["\r"];
}
