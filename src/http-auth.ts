/**
 * Auth decisions for the channel server's HTTP listener, extracted pure so the
 * fail-closed property is testable. The old inline guard was
 * `if (AUTH_TOKEN && header !== AUTH_TOKEN)` — the short-circuit meant an
 * empty TELECLAUDE_AUTH_TOKEN accepted every local POST (message injection,
 * permission verdicts, ask_user answers). The daemon's own callback guard
 * already fails closed (daemon.ts rejects when !expectedToken); this brings
 * the channel server in line.
 */
export type HttpAuthDecision = { ok: true } | { ok: false; status: number; body: string };

/** All POSTs: exact token match required; no token configured means reject all. */
export function postAuthDecision(serverToken: string, header: string | string[] | undefined): HttpAuthDecision {
  if (!serverToken || header !== serverToken) {
    return { ok: false, status: 401, body: "unauthorized" };
  }
  return { ok: true };
}

/**
 * GET /ready: a token-less server may never report ready (waitForReady would
 * green-light a spawn nothing authenticated owns). A *mismatched* token is 409
 * — the recycled-port protection (a dying server must not answer readiness for
 * the newer spawn that owns the port now). A missing header stays tolerated,
 * matching the existing probe behavior. The token is compared, never echoed.
 */
export function readyAuthDecision(serverToken: string, header: string | string[] | undefined): HttpAuthDecision {
  if (!serverToken) return { ok: false, status: 503, body: "no auth token" };
  if (header !== undefined && header !== serverToken) {
    return { ok: false, status: 409, body: "wrong spawn" };
  }
  return { ok: true };
}
