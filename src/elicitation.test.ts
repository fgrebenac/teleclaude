import { describe, it, expect } from "vitest";
import {
  elicitationContextNote, elicitationDecline, elicitationSource, formatElicitationNotice,
} from "./elicitation.js";

describe("elicitationDecline", () => {
  it("is the exact hook decision shape Claude Code expects", () => {
    expect(JSON.parse(elicitationDecline())).toEqual({
      hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" },
    });
  });

  it("declines rather than accepting with empty content", () => {
    // Accepting with no content would hand the server garbage; cancel/decline
    // both unblock, and decline is the one that reads as "not available here".
    expect(elicitationDecline()).toContain('"action":"decline"');
    expect(elicitationDecline()).not.toContain("accept");
  });

  it("is valid JSON — it goes straight into the HTTP response body", () => {
    expect(() => JSON.parse(elicitationDecline())).not.toThrow();
  });
});

describe("elicitationSource", () => {
  it("prefers the server name", () => {
    expect(elicitationSource({ server_name: "acme", tool_name: "create_project" })).toBe("acme");
  });

  it("accepts the camelCase spelling too", () => {
    // The field name isn't guaranteed across Claude Code versions.
    expect(elicitationSource({ serverName: "acme" })).toBe("acme");
  });

  it("falls back to the tool name, then to a generic label", () => {
    expect(elicitationSource({ tool_name: "mcp__x__y" })).toBe("mcp__x__y");
    expect(elicitationSource({})).toBe("an MCP server");
  });

  it("ignores blank and non-string values instead of showing empty text", () => {
    expect(elicitationSource({ server_name: "   " })).toBe("an MCP server");
    expect(elicitationSource({ server_name: 42 })).toBe("an MCP server");
  });

  it("trims, so the notice doesn't get ragged spacing", () => {
    expect(elicitationSource({ server_name: "  acme \n" })).toBe("acme");
  });
});

describe("formatElicitationNotice", () => {
  it("names the source and says it was declined, not that it failed", () => {
    const msg = formatElicitationNotice("acme");
    expect(msg).toContain("acme");
    expect(msg).toContain("declined");
  });

  it("tells the user what to expect next", () => {
    expect(formatElicitationNotice("acme")).toMatch(/ask/i);
  });

  it("stays plain text — server names are untrusted and it's sent without parse_mode", () => {
    const msg = formatElicitationNotice("<b>evil & co</b>");
    expect(msg).toContain("<b>evil & co</b>");
  });
});

describe("elicitationContextNote", () => {
  it("explains why and points Claude at the reply tool", () => {
    const note = elicitationContextNote("acme");
    expect(note).toContain("acme");
    expect(note).toContain("reply tool");
  });

  it("tells Claude not to retry — a retry would hang the turn again", () => {
    expect(elicitationContextNote("acme")).toMatch(/do not retry/i);
  });

  it("is bracketed like the other injected system notes", () => {
    const note = elicitationContextNote("acme");
    expect(note.startsWith("[")).toBe(true);
    expect(note.endsWith("]")).toBe(true);
  });
});
