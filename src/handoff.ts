/**
 * /handoff (Telegram → terminal): stop this topic's Claude Code process and
 * hand the user a copy-paste command to pick the SAME session up in their
 * terminal. Cheap by design — the session id is already persisted
 * (sessions.json) and `claude --resume <id>` is the whole mechanism; this
 * module's only job is the exact reply text.
 *
 * Deliberately one-directional: it never checks whether the session is
 * already open somewhere else (that's resumeSession's job, via
 * live-sessions.ts) — a topic's own current session can't be "live elsewhere"
 * by construction, it's the one process that had it.
 */

import { escapeHtml } from "./telegram-format.js";

/**
 * Build the reply for /handoff. Pure so the exact copy is testable without a
 * live process or Telegram.
 */
export function buildHandoffMessage(projectPath: string, sessionId: string, wasRunning: boolean): string {
  const command = `cd ${projectPath} && claude --resume ${sessionId}`;
  const lines = [
    wasRunning
      ? "🤝 Session stopped here — pick it up in your terminal:"
      : "🤝 No session was running here — pick it up in your terminal:",
    `<pre>${escapeHtml(command)}</pre>`,
    "Sending a message in this topic resumes the SAME session again — finish your terminal work first, or two processes will write to the same transcript at once.",
  ];
  return lines.join("\n");
}
