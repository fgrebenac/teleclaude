/**
 * Which permission mode a topic's Claude Code session runs in.
 *
 * teleclaude used to run every session with `--dangerously-skip-permissions`,
 * by default — no safety checks at all, on a bot anyone in an allowlisted group
 * can drive from a phone. `auto` replaces that: a classifier reviews actions
 * before they run and blocks the escalation/exfiltration/destruction classes,
 * while routine local work still runs without prompts.
 *
 * `auto` also fails soft in exactly the direction we want. When the classifier
 * blocks 3 actions in a row (or 20 in a session), Claude Code resumes
 * prompting — and our permission relay turns those prompts into Telegram
 * buttons. Same if the session's model doesn't support auto mode: it degrades
 * to prompts rather than erroring. Supervision is the fallback, not a hang.
 */
export type PermissionMode = "auto" | "bypass" | "default";

export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "default", "bypass"];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

/** What a topic persists. `bypass` is the legacy boolean, still read on load. */
export interface PermissionModeState {
  permissionMode?: PermissionMode;
  bypass?: boolean;
}

/**
 * Resolve the mode for a topic. An explicit `permissionMode` wins; otherwise a
 * legacy `bypass` boolean is honoured (it was an explicit choice made with the
 * old /bypass command, so don't silently override it); otherwise the default.
 *
 * Note the asymmetry with the old code: absent state used to mean bypass,
 * because `bypass = true` was the default. Absent now means `auto`.
 */
export function resolvePermissionMode(state: PermissionModeState | undefined): PermissionMode {
  if (state?.permissionMode && PERMISSION_MODES.includes(state.permissionMode)) {
    return state.permissionMode;
  }
  if (typeof state?.bypass === "boolean") return state.bypass ? "bypass" : "default";
  return DEFAULT_PERMISSION_MODE;
}

/** CLI flags for `claude`. Always explicit, so a stray user-level `defaultMode` can't change what a topic runs as. */
export function permissionModeArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case "bypass":
      return ["--dangerously-skip-permissions"];
    case "auto":
      return ["--permission-mode", "auto"];
    case "default":
      return ["--permission-mode", "default"];
  }
}

export function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case "auto":
      return "⚡ Auto (classifier-checked)";
    case "default":
      return "🔐 Supervised (ask via Telegram)";
    case "bypass":
      return "☠️ Bypass (no checks)";
  }
}

/** Short form for /status and inline buttons. */
export function permissionModeShort(mode: PermissionMode): string {
  switch (mode) {
    case "auto":
      return "⚡ Auto";
    case "default":
      return "🔐 Supervised";
    case "bypass":
      return "☠️ Bypass";
  }
}

/** One line explaining the trade-off, shown when a mode is selected. */
export function permissionModeHelp(mode: PermissionMode): string {
  switch (mode) {
    case "auto":
      return "A classifier vets each action; escalation, exfiltration and destructive work is blocked, and repeated blocks fall back to asking here.";
    case "default":
      return "Every action outside reads asks first — approvals arrive here as Allow/Deny buttons.";
    case "bypass":
      return "No checks and no prompts at all, including no prompt-injection protection. Use only if you know why you need it.";
  }
}

export function parsePermissionMode(arg: string): PermissionMode | null {
  const v = arg.trim().toLowerCase();
  if (v === "auto") return "auto";
  if (v === "bypass" || v === "bypasspermissions" || v === "skip") return "bypass";
  if (v === "default" || v === "manual" || v === "supervised" || v === "ask") return "default";
  return null;
}
