import { existsSync } from "fs";
import { join } from "path";

export interface McpCommand {
  command: string;
  args: string[];
}

/**
 * How to launch the channel server, decided by what sits next to this file at
 * runtime. A bundled build ships dist/channel-server.js and runs it with plain
 * `node` — the 2026-08-21 spike verified MCP stdio works there (the historical
 * breakage was the tsx *loader* via `node --import tsx`, not node itself). A
 * dev checkout has only src/channel-server.ts and keeps the proven
 * `npx tsx` launch. When this module is bundled into dist/index.js,
 * import.meta.dirname is dist/; under tsx it is src/.
 */
export function channelServerCommand(dir: string = import.meta.dirname): McpCommand {
  const bundled = join(dir, "channel-server.js");
  if (existsSync(bundled)) return { command: "node", args: [bundled] };
  return { command: "npx", args: ["tsx", join(dir, "channel-server.ts")] };
}
