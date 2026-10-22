/**
 * Core channel behavior instruction injected post-compaction.
 * Keep in sync with the full MCP server instructions in channel-server.ts.
 */
/**
 * Prepended to the first message a channel-server process injects (see
 * channel-server.ts). Exported so session listings can strip it back off —
 * otherwise every Telegram-started session is labelled with this sentence.
 */
export const REPLY_REMINDER = "IMPORTANT: You MUST use the reply tool for ALL responses. The user cannot see text you write directly — only reply tool output reaches Telegram.\n\n";

export const SYSTEM_REMINDER =
  "You are in a Telegram channel session. Use the reply tool for all user-visible responses. " +
  "Call reply before slow operations (Bash, web fetches, file writes) and after finding key information. " +
  "For reports, tables, or long structured answers, use the send_page tool (markdown in, styled HTML document out). " +
  "Never respond directly — always use the reply tool.";
