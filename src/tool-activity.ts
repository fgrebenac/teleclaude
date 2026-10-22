import { basename } from "path";

/** Tools too frequent or internal to be worth a live-view line. */
const TOOL_SKIP = new Set([
  "Glob", "Grep", "LS", "TodoWrite", "TodoRead",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "Skill", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
]);

/** One live-view line for a tool call, or null when the tool is skipped. */
export function formatToolActivity(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (TOOL_SKIP.has(toolName)) return null;
  if (toolName.startsWith("mcp__teleclaude")) return null;
  switch (toolName) {
    case "Bash":
      return `⚙️ Bash: ${String(toolInput.command ?? "").slice(0, 60)}`;
    case "Read":
      return `📖 Reading: ${basename(String(toolInput.file_path ?? ""))}`;
    case "Edit":
    case "Write":
      return `✏️ Editing: ${basename(String(toolInput.file_path ?? ""))}`;
    case "WebSearch":
      return `🔍 Searching: ${String(toolInput.query ?? "").slice(0, 60)}`;
    case "WebFetch": {
      try { return `🌐 Fetching: ${new URL(String(toolInput.url ?? "")).hostname}`; }
      catch { return `🌐 Fetching...`; }
    }
    case "Agent":
      return `🤖 Spawning agent...`;
    default: {
      // MCP tools: "mcp__server__tool" → "server: tool"
      if (toolName.startsWith("mcp__")) {
        const [, server, tool] = toolName.split("__");
        return `🔧 ${server}${tool ? `: ${tool}` : ""}`;
      }
      return `🔧 ${toolName}`;
    }
  }
}
