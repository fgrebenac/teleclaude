/**
 * Typed Telegram Bot API failure. status 0 = transport-level (fetch threw /
 * abort / unparseable response) — the request may or may not have landed.
 */
export class TelegramApiError extends Error {
  constructor(
    method: string,
    public readonly description: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export type TelegramErrorKind =
  | "rate-limit"   // 429 — wait retryAfter, then one retry is safe and expected
  | "parse"        // HTML rejected — resend as plain text
  | "not-modified" // edit with identical content — success, not failure
  | "too-long"     // over 4096 — resend stripped/plain
  | "network"      // transport failure — AMBIGUOUS for sends (may have landed)
  | "other";       // deterministic rejection we don't special-case

export function classifyTelegramError(err: unknown): TelegramErrorKind {
  if (!(err instanceof TelegramApiError)) return "other";
  if (err.status === 0) return "network";
  if (err.status === 429 || err.retryAfter !== undefined) return "rate-limit";
  const d = err.description.toLowerCase();
  if (d.includes("can't parse entities")) return "parse";
  if (d.includes("message is not modified")) return "not-modified";
  if (d.includes("too long")) return "too-long";
  return "other";
}
