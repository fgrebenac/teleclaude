import { describe, it, expect } from "vitest";
import { deriveOutcome } from "./tool-outcome.js";

describe("deriveOutcome", () => {
  const cases: { name: string; input: unknown; ok: boolean | undefined; errorSnippet?: string }[] = [
    {
      name: "bash success",
      input: { stdout: "hi", stderr: "", interrupted: false },
      ok: true,
    },
    {
      name: "interrupted",
      input: { interrupted: true },
      ok: false,
    },
    {
      name: "is_error + error string",
      input: { is_error: true, error: "boom" },
      ok: false,
      errorSnippet: "boom",
    },
    {
      name: "stderr alone is not proof of failure",
      input: { stderr: "warning" },
      ok: true,
    },
    {
      name: "missing response",
      input: undefined,
      ok: undefined,
    },
    {
      name: "null response",
      input: null,
      ok: undefined,
    },
    {
      name: "string response",
      input: "some plain text result",
      ok: true,
    },
    {
      name: "bash nonzero exit_code with stderr",
      input: { exit_code: 1, stderr: "fail" },
      ok: false,
      errorSnippet: "fail",
    },
    {
      name: "bash nonzero code (alt field name) with stderr",
      input: { code: 2, stderr: "nope" },
      ok: false,
      errorSnippet: "nope",
    },
    {
      name: "zero exit_code is success",
      input: { exit_code: 0, stdout: "ok" },
      ok: true,
    },
    {
      name: "empty error string is not a failure signal",
      input: { error: "" },
      ok: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = deriveOutcome(c.input);
      expect(result.ok).toBe(c.ok);
      if (c.errorSnippet !== undefined) {
        expect(result.errorSnippet).toBe(c.errorSnippet);
      }
    });
  }

  it("strips control characters and caps the snippet at 120 chars", () => {
    const long = "x".repeat(200);
    const result = deriveOutcome({ is_error: true, error: `bad\x00\x1fvalue\x7f${long}` });
    expect(result.ok).toBe(false);
    expect(result.errorSnippet?.length).toBe(120);
    expect(result.errorSnippet).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(result.errorSnippet?.startsWith("bad value")).toBe(true);
  });

  it("prefers stderr over the error field when both are present", () => {
    const result = deriveOutcome({ is_error: true, error: "error-field", stderr: "stderr-field" });
    expect(result.errorSnippet).toBe("stderr-field");
  });

  it("has no error snippet for a successful response", () => {
    const result = deriveOutcome({ stdout: "ok" });
    expect(result.ok).toBe(true);
    expect(result.errorSnippet).toBeUndefined();
  });
});
