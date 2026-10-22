import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { log } from "./log.js";
import { readAccessToken } from "./claude-auth.js";

export interface EffortCapability { supported?: boolean }
export interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  capabilities?: { effort?: { supported?: boolean } & Record<string, EffortCapability | boolean | undefined> };
}

// Fallback list — updated when new models release
const FALLBACK_MODELS: AnthropicModel[] = [
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", max_input_tokens: 1_000_000 },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", max_input_tokens: 1_000_000 },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
  { id: "claude-fable-5", display_name: "Claude Fable 5", max_input_tokens: 200_000 },
];

// Short aliases the claude CLI accepts
export const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku", "fable", "opusplan"];

export interface ModelList {
  models: AnthropicModel[];
  fromApi: boolean; // true = live list, safe for strict validation
}

let cached: ModelList | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getApiKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const configPath = join(homedir(), ".teleclaude", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.apiKey) return cfg.apiKey;
    } catch { /* ignore */ }
  }
  return undefined;
}

async function tryFetchModels(headers: Record<string, string>): Promise<AnthropicModel[] | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log(`[models] API returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { data: AnthropicModel[] };
    const models = data.data.filter((m) => m.id.startsWith("claude-"));
    return models.length > 0 ? models : null;
  } catch (e) {
    log(`[models] fetch error: ${e}`);
    return null;
  }
}

export async function fetchAvailableModels(): Promise<ModelList> {
  if (cached && Date.now() < cacheExpiresAt) return cached;

  let models: AnthropicModel[] | null = null;

  const apiKey = getApiKey();
  if (apiKey) {
    models = await tryFetchModels({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  }
  if (!models) {
    // Subscription (OAuth) path — same token quota.ts uses
    const oauth = await readAccessToken();
    if (oauth) {
      models = await tryFetchModels({
        Authorization: `Bearer ${oauth}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      });
    }
  }

  if (models) {
    log(`[models] fetched ${models.length} models`);
    cached = { models, fromApi: true };
  } else {
    cached = { models: FALLBACK_MODELS, fromApi: false };
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cached;
}

/**
 * Resolve user input to a model the CLI will accept, or null if invalid.
 * Strict (exact alias or listed id) when the list is live; shape-check
 * fallback when the API was unreachable.
 */
export function resolveModel(input: string, models: AnthropicModel[], fromApi: boolean): string | null {
  // Claude Code accepts a [1m] suffix for 1M-context sessions — match on the base
  const base = input.replace(/\[1m\]$/, "");
  if (MODEL_ALIASES.includes(base)) return input;
  if (models.some((m) => m.id === base)) return input;
  if (!fromApi && /^claude-[a-z0-9.-]+(\[1m\])?$/.test(input)) return input;
  return null;
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Effort levels a model supports, from API capabilities. Unknown → all levels. */
export function supportedEffortLevels(model: AnthropicModel | undefined): string[] {
  const eff = model?.capabilities?.effort;
  // No capability data (fallback list / older API) — assume all levels
  if (!eff) return [...EFFORT_LEVELS];
  // API explicitly says this model doesn't support effort
  if (!eff.supported) return [];
  return EFFORT_LEVELS.filter((l) => {
    const cap = eff[l];
    return typeof cap === "object" ? cap?.supported === true : cap === true;
  });
}

export interface CuratedModel { value: string; label: string }

/**
 * Mirror Claude Code's curated /model picker: account default, the latest
 * model per family (API returns newest first), and 1M-context variants
 * where supported. Values are CLI aliases (what --model accepts).
 */
export function curatedModels(models: AnthropicModel[]): CuratedModel[] {
  const entries: CuratedModel[] = [{ value: "default", label: "Default (account setting)" }];
  for (const family of ["opus", "sonnet", "haiku", "fable"]) {
    const latest = models.find((m) => m.id.startsWith(`claude-${family}-`));
    if (!latest) continue;
    const label = latest.display_name ?? latest.id;
    entries.push({ value: family, label });
    if ((latest.max_input_tokens ?? 0) >= 1_000_000) {
      entries.push({ value: `${family}[1m]`, label: `${label} — 1M context` });
    }
  }
  return entries;
}

/** Latest model in a family, for capability lookups from an alias or id. */
export function findModelForValue(value: string, models: AnthropicModel[]): AnthropicModel | undefined {
  const base = value.replace(/\[1m\]$/, "");
  if (base === "default" || base === "opusplan" || base === "best") {
    return models.find((m) => m.id.startsWith("claude-opus-")) ?? models[0];
  }
  if (["opus", "sonnet", "haiku", "fable"].includes(base)) {
    return models.find((m) => m.id.startsWith(`claude-${base}-`));
  }
  return models.find((m) => m.id === base);
}
