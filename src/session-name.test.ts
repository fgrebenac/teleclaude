import { describe, it, expect } from "vitest";
import {
  sanitizeSessionName,
  renameCommandText,
  resolveRenameOutcome,
  MAX_SESSION_NAME_LENGTH,
} from "./session-name.js";

describe("sanitizeSessionName", () => {
  it("passes an ordinary name through", () => {
    expect(sanitizeSessionName("quota alerts")).toBe("quota alerts");
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeSessionName("  fix   the   scheduler  ")).toBe("fix the scheduler");
  });

  it("distinguishes no argument from an unusable one", () => {
    // undefined = "no name given" → caller lets Claude Code generate one.
    expect(sanitizeSessionName(undefined)).toBeUndefined();
    // A string that empties out = a typo → caller reports an error.
    expect(sanitizeSessionName("")).toBeUndefined();
    expect(sanitizeSessionName("   ")).toBeUndefined();
    expect(sanitizeSessionName("\u0000\u0007")).toBeUndefined();
  });

  it("strips control characters — they would be interpreted as PTY input", () => {
    // The load-bearing case: a newline would submit /rename early and turn the
    // rest into an ordinary prompt for Claude.
    const name = sanitizeSessionName("harmless\rrm -rf /\n");
    expect(name).toBe("harmless rm -rf /");
    expect(renameCommandText(name)).toBe("/rename harmless rm -rf /");
    // No carriage return in the text: the only one reaching the PTY is the
    // separately written submit.
    expect(renameCommandText(name)).not.toMatch(/[\r\n]/);
  });

  it("strips escape sequences", () => {
    expect(sanitizeSessionName("plain\u001b[31mred")).toBe("plain [31mred");
  });

  it("caps the length and re-trims the cut edge", () => {
    const long = sanitizeSessionName("x".repeat(200))!;
    expect(long).toHaveLength(MAX_SESSION_NAME_LENGTH);
    // A cut landing on a space must not leave a trailing one.
    const cut = sanitizeSessionName("y".repeat(MAX_SESSION_NAME_LENGTH - 1) + " tail")!;
    expect(cut).toBe("y".repeat(MAX_SESSION_NAME_LENGTH - 1));
  });

  it("keeps non-ASCII names intact", () => {
    expect(sanitizeSessionName("Café — kolovoz")).toBe("Café — kolovoz");
  });
});

describe("renameCommandText", () => {
  it("is a bare /rename when no name is given (Claude Code generates one)", () => {
    expect(renameCommandText()).toBe("/rename");
    expect(renameCommandText(undefined)).toBe("/rename");
  });

  it("carries no carriage return — Enter is a separate write", () => {
    expect(renameCommandText("api work")).toBe("/rename api work");
  });
});

describe("resolveRenameOutcome", () => {
  it("confirms when the registry shows the requested name", () => {
    expect(resolveRenameOutcome("api work", "todo-c6", "api work"))
      .toEqual({ status: "confirmed", name: "api work" });
  });

  it("reports the adjusted name when Claude Code picked a variant", () => {
    // Another live session already held "api work".
    expect(resolveRenameOutcome("api work", "todo-c6", "api-work-2"))
      .toEqual({ status: "adjusted", name: "api-work-2" });
  });

  it("treats any change as success for a bare /rename", () => {
    expect(resolveRenameOutcome(undefined, "todo-c6", "fix-login-bug"))
      .toEqual({ status: "confirmed", name: "fix-login-bug" });
  });

  it("is unconfirmed when nothing changed", () => {
    expect(resolveRenameOutcome(undefined, "todo-c6", "todo-c6"))
      .toEqual({ status: "unconfirmed", name: "todo-c6" });
  });

  it("is unconfirmed when the registry can't be read", () => {
    expect(resolveRenameOutcome("api work", "todo-c6", undefined))
      .toEqual({ status: "unconfirmed" });
  });

  it("confirms a rename to the name it already had", () => {
    // Nothing changes in the registry, but the request was satisfied — claiming
    // otherwise would be a false negative.
    expect(resolveRenameOutcome("api work", "api work", "api work"))
      .toEqual({ status: "confirmed", name: "api work" });
  });
});
