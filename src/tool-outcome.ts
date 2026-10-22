/** Result of inspecting a tool's response payload for success/failure. */
export interface ToolOutcome {
  /** `true` succeeded, `false` failed, `undefined` when the response is
   *  missing/unparseable and no verdict can be derived. */
  ok: boolean | undefined;
  /** First 120 chars of the failure's stderr/error text, control characters
   *  stripped. Only set when `ok === false`. */
  errorSnippet: string | undefined;
}

const MAX_SNIPPET_LEN = 120;

/** First 120 chars of `s` with control characters collapsed to a space —
 *  shared by deriveOutcome and any other daemon-side fallback that needs the
 *  same truncation rule (e.g. a PostToolUseFailure payload shaped differently
 *  than a PostToolUse tool_response). */
export function snippet(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, MAX_SNIPPET_LEN);
}

/**
 * Derive a pass/fail verdict from a PostToolUse `tool_response` payload.
 *
 * `tool_response` shapes vary by tool (Bash carries stdout/stderr/interrupted/
 * exit_code, the Agent tool carries isAsync/status/agentId, others may just be
 * a plain string), so this only looks for the handful of fields that
 * consistently signal failure across tools: an explicit `interrupted`/
 * `is_error` flag, an `error` string, or (Bash-specific) a nonzero
 * `exit_code`/`code`. `stderr` on its own is NOT proof of failure — plenty of
 * successful commands write warnings to it.
 */
export function deriveOutcome(toolResponse: unknown): ToolOutcome {
  if (toolResponse === undefined || toolResponse === null) {
    return { ok: undefined, errorSnippet: undefined };
  }
  if (typeof toolResponse !== "object") {
    // A plain string (or other primitive) result — its mere presence means
    // the tool ran and returned something, so treat it as success.
    return { ok: true, errorSnippet: undefined };
  }

  const r = toolResponse as Record<string, unknown>;
  const interrupted = r.interrupted === true;
  const isError = r.is_error === true;
  // An empty string is not a failure signal — some tools return `error: ""`
  // as a no-op default, and treating it as a verdict would render a dangling
  // "· ❌ " with nothing after it.
  const errorField = typeof r.error === "string" && r.error.length > 0 ? r.error : undefined;
  const exitCodeRaw = r.exit_code ?? r.code;
  const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : undefined;
  const nonzeroExit = exitCode !== undefined && exitCode !== 0;

  const failed = interrupted || isError || errorField !== undefined || nonzeroExit;
  if (!failed) return { ok: true, errorSnippet: undefined };

  const stderr = typeof r.stderr === "string" && r.stderr.length > 0 ? r.stderr : undefined;
  const source = stderr ?? errorField;
  return { ok: false, errorSnippet: source !== undefined ? snippet(source) : undefined };
}
