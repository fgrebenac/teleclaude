import { describe, it, expect } from "vitest";
import { resolveModel, curatedModels, supportedEffortLevels } from "./models.js";

const MODELS = [
  { id: "claude-opus-4-8" },
  { id: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5-20251001" },
];

const RICH_MODELS = [
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", max_input_tokens: 1_000_000 },
  { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", max_input_tokens: 1_000_000 },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", max_input_tokens: 1_000_000 },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", max_input_tokens: 200_000 },
  { id: "claude-fable-5", display_name: "Claude Fable 5", max_input_tokens: 200_000 },
];

describe("curatedModels", () => {
  it("returns default + latest per family + 1M variants", () => {
    const entries = curatedModels(RICH_MODELS);
    expect(entries.map((e) => e.value)).toEqual([
      "default", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable",
    ]);
    expect(entries.find((e) => e.value === "opus")!.label).toBe("Claude Opus 4.8");
    expect(entries.find((e) => e.value === "opus[1m]")!.label).toBe("Claude Opus 4.8 — 1M context");
    expect(entries.find((e) => e.value === "fable")!.label).toBe("Claude Fable 5");
  });

  it("skips 1M variants for models without 1M input", () => {
    const entries = curatedModels(RICH_MODELS);
    expect(entries.some((e) => e.value === "haiku[1m]")).toBe(false);
  });

  it("falls back gracefully when a family is missing", () => {
    const entries = curatedModels([{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }]);
    expect(entries.map((e) => e.value)).toEqual(["default", "opus"]);
  });
});

describe("supportedEffortLevels", () => {
  it("reads per-level support from capabilities", () => {
    const model = {
      id: "claude-opus-4-8",
      capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } },
    };
    expect(supportedEffortLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("filters unsupported levels", () => {
    const model = {
      id: "x",
      capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } },
    };
    expect(supportedEffortLevels(model)).toEqual(["low", "high"]);
  });

  it("returns no levels when the API says effort is unsupported", () => {
    expect(supportedEffortLevels({ id: "x", capabilities: { effort: { supported: false } } })).toEqual([]);
  });

  it("returns all levels when capabilities are unknown (fallback)", () => {
    expect(supportedEffortLevels(undefined)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(supportedEffortLevels({ id: "x" })).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("resolveModel aliases", () => {
  it("accepts the picker aliases incl. [1m] and default", () => {
    expect(resolveModel("default", MODELS, true)).toBe("default");
    expect(resolveModel("opusplan", MODELS, true)).toBe("opusplan");
    expect(resolveModel("sonnet[1m]", MODELS, true)).toBe("sonnet[1m]");
    expect(resolveModel("opus[1m]", MODELS, true)).toBe("opus[1m]");
    expect(resolveModel("fable", MODELS, true)).toBe("fable");
  });
});

describe("resolveModel", () => {
  it("accepts aliases regardless of list source", () => {
    expect(resolveModel("sonnet", MODELS, true)).toBe("sonnet");
    expect(resolveModel("opus", MODELS, false)).toBe("opus");
  });

  it("accepts exact ids from the fetched list", () => {
    expect(resolveModel("claude-opus-4-8", MODELS, true)).toBe("claude-opus-4-8");
  });

  it("rejects ids not in the list when the list came from the API", () => {
    expect(resolveModel("claude-opsu-4-8", MODELS, true)).toBeNull();
  });

  it("accepts [1m]-suffixed ids when the base id is listed", () => {
    expect(resolveModel("claude-opus-4-8[1m]", MODELS, true)).toBe("claude-opus-4-8[1m]");
    expect(resolveModel("claude-opsu-4-8[1m]", MODELS, true)).toBeNull();
  });

  it("falls back to a shape check when the list is the static fallback", () => {
    expect(resolveModel("claude-opus-5", MODELS, false)).toBe("claude-opus-5");
    expect(resolveModel("gpt-4", MODELS, false)).toBeNull();
  });
});
