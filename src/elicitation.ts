/**
 * MCP elicitation in a session no human is watching.
 *
 * An MCP server can ask the *user* for structured input mid-tool-call
 * (`elicitation/create`). Claude Code renders a form dialog and blocks the turn
 * until it's answered. In a teleclaude topic that dialog appears in a PTY nobody
 * is looking at, so the turn hangs until the stall alert fires — the same failure
 * class as the permission-relay gaps: something needs a human and the human is
 * on Telegram.
 *
 * Unlike a permission prompt, there is no asynchronous verdict channel to answer
 * an elicitation with: the `Elicitation` hook's response *is* the answer, and it
 * is synchronous. Holding the HTTP response open while we wait for someone to tap
 * a Telegram button would stall the turn for as long as they take, so instead we
 * decline immediately and tell both sides why. Failing fast and visibly beats an
 * invisible stall, and Claude can then just ask through the reply tool, which is
 * the one channel that does reach the user.
 *
 * `--strict-mcp-config` (config `defaults.strictMcpConfig`) makes this rare by
 * construction — only our own channel server is loaded, and it never elicits.
 */

/** Hook response telling Claude Code to decline the elicitation. */
export function elicitationDecline(): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" },
  });
}

/** Best-effort server label — the field name isn't guaranteed across versions. */
export function elicitationSource(body: Record<string, unknown>): string {
  for (const key of ["server_name", "serverName", "mcp_server", "tool_name"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "an MCP server";
}

/** Telegram notice. Plain text: server names and prompts are untrusted input. */
export function formatElicitationNotice(source: string): string {
  return [
    `🧩 ${source} asked for interactive input`,
    "",
    "That form can only be answered at the terminal, so it was declined automatically to keep this topic from hanging. Claude should ask here instead.",
  ].join("\n");
}

/** Injected into the session so Claude understands and re-asks the right way. */
export function elicitationContextNote(source: string): string {
  return `[${source} requested interactive input from the user. It was declined automatically: this session has no interactive terminal, and its form dialog would never be seen. Do not retry it. If you need that information, ask the user with the reply tool instead.]`;
}
