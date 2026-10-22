import { describe, it, expect } from "vitest";
import { formatDuration, formatTokens, formatReceipt } from "./turn-receipt.js";

describe("formatDuration", () => {
  it("renders seconds", () => expect(formatDuration(42_000)).toBe("42s"));
  it("renders minutes + seconds", () => expect(formatDuration(4 * 60_000 + 12_000)).toBe("4m 12s"));
  it("renders hours + minutes", () => expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m"));
  it("clamps negatives to 0s", () => expect(formatDuration(-5)).toBe("0s"));
});

describe("formatTokens", () => {
  it("keeps small numbers verbatim", () => expect(formatTokens(950)).toBe("950"));
  it("renders thousands with one decimal", () => expect(formatTokens(3_240)).toBe("3.2k"));
  it("drops the decimal past 10k", () => expect(formatTokens(45_600)).toBe("46k"));
  it("renders millions", () => expect(formatTokens(1_200_000)).toBe("1.2M"));
});

describe("formatReceipt", () => {
  it("renders the full receipt", () => {
    expect(formatReceipt({ durationMs: 252_000, toolCount: 7, outputTokens: 3_240 }))
      .toBe("⏱ 4m 12s · 🔧 7 tools · ~3.2k tokens out");
  });
  it("uses the singular for one tool", () => {
    expect(formatReceipt({ durationMs: 1_000, toolCount: 1 })).toBe("⏱ 1s · 🔧 1 tool");
  });
  it("omits the token segment when no baseline exists", () => {
    expect(formatReceipt({ durationMs: 1_000, toolCount: 0 })).toBe("⏱ 1s · 🔧 0 tools");
  });
});
