/**
 * Pure(ish) validators for `teleclaude setup` input.
 *
 * Extracted so the reprompt/exit-code flow in cli.ts's setup() can be driven
 * by structured results instead of parseInt-and-filter, which used to
 * silently produce `ownerTelegramIds: []` for garbage input ("my ID is
 * @alice") — a config that starts up fine and then ignores every message
 * forever. Network access is injected (`fetchImpl`) so tests never hit
 * api.telegram.org.
 */

export type IdParse = { ok: true; ids: number[] } | { ok: false; error: string };

/**
 * Parses a comma-separated list of Telegram numeric user IDs. Rejects empty
 * input and any non-numeric entry, naming the offending token(s) so the user
 * knows what to fix rather than silently dropping them.
 */
export function parseOwnerIds(input: string): IdParse {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!parts.length) {
    return {
      ok: false,
      error: "At least one Telegram user ID is required — message @userinfobot to get yours.",
    };
  }

  const bad = parts.filter((p) => !/^\d{1,15}$/.test(p));
  if (bad.length) {
    return {
      ok: false,
      error: `Not a numeric Telegram ID: ${bad.join(", ")} (IDs are numbers, e.g. 123456789 — message @userinfobot)`,
    };
  }

  return { ok: true, ids: parts.map(Number) };
}

export type TokenCheck = { ok: true; username: string } | { ok: false; error: string };

type FetchLike = (url: string) => Promise<Response>;

const GETME_TIMEOUT_MS = 8000;

/** Default fetch impl: real network call, bounded so a wedged connection can't hang setup forever. */
async function defaultFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GETME_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates a Telegram bot token: a cheap local shape check first (so a
 * typo never reaches the network), then a live `getMe` call against the
 * injected fetch. Distinguishes "Telegram rejected this token" from
 * "couldn't reach Telegram at all" so the user knows whether to fix the
 * token or their connection.
 */
export async function validateBotToken(
  token: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<TokenCheck> {
  const t = token.trim();
  if (!/^\d+:[\w-]{20,}$/.test(t)) {
    return {
      ok: false,
      error: "That doesn't look like a bot token (expected the 123456:ABC-DEF… string from @BotFather).",
    };
  }

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${t}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (!json.ok) {
      return { ok: false, error: `Telegram rejected the token: ${json.description ?? "unauthorized"}` };
    }
    return { ok: true, username: json.result?.username ?? "?" };
  } catch {
    return { ok: false, error: "Could not reach api.telegram.org — check connectivity and retry." };
  }
}
