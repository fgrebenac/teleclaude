/**
 * When a freshly spawned topic may be POSTed to.
 *
 * Two independent signals, and conflating them cost two live incidents (a `/new`
 * followed immediately by a message, on 2026-08-13 and 2026-08-18 — both ended
 * with "POST to :<port> failed fetch failed" and the daemon killing a perfectly
 * healthy session):
 *
 *   - `channelStatus` comes from Claude Code's *hooks*. "registered" proves
 *     Claude Code is alive and the org hasn't blocked channels. Measured live:
 *     it arrives ~4.6s after spawn (~1s when resuming).
 *   - the HTTP probe proves the MCP channel server — an `npx tsx` subprocess —
 *     has bound its port and connected MCP. Measured live: ~8.0s after spawn.
 *
 * Only the second one means "a POST will arrive". The hook's job is to let us
 * skip the grace wait, because that wait exists solely to catch a block banner
 * that arrives *after* a green port — and a hook is proof no block is coming.
 */

export type ChannelReadyStatus = "pending" | "registered" | "blocked";
export type ReadyDecision = "ready" | "blocked" | "wait";

export interface ReadinessInput {
  /** Latest channel status from the hooks/PTY scanner. */
  channelStatus: ChannelReadyStatus | undefined;
  /** Status code from GET /ready: 200 ready, 503 server up but MCP not connected,
   *  409 a different spawn's server holds this (recycled) port, 0 unreachable. */
  httpStatus: number;
  /** How long the port has been answering 200, or undefined if it isn't. */
  msSinceFirstHttpOk: number | undefined;
  graceMs: number;
}

export function readinessDecision(input: ReadinessInput): ReadyDecision {
  if (input.channelStatus === "blocked") return "blocked";
  // No green port, no delivery — whatever the hooks say.
  if (input.httpStatus !== 200) return "wait";
  if (input.channelStatus === "registered") return "ready";
  return (input.msSinceFirstHttpOk ?? 0) >= input.graceMs ? "ready" : "wait";
}
