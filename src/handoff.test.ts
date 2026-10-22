import { describe, it, expect } from "vitest";
import { buildHandoffMessage } from "./handoff.js";

describe("buildHandoffMessage", () => {
  it("includes a copy-paste cd + claude --resume command", () => {
    const msg = buildHandoffMessage("/Users/x/Work/Todo", "35133a33-da1c-4664-8110-19d27c9518af", true);
    expect(msg).toContain("cd /Users/x/Work/Todo &amp;&amp; claude --resume 35133a33-da1c-4664-8110-19d27c9518af");
  });

  it("says the session was stopped here when it was running", () => {
    expect(buildHandoffMessage("/p", "abc", true)).toContain("Session stopped here");
  });

  it("says nothing was running when it wasn't", () => {
    const msg = buildHandoffMessage("/p", "abc", false);
    expect(msg).not.toContain("Session stopped here");
    expect(msg).toContain("No session was running here");
  });

  it("warns about the two-writer hazard on the next message", () => {
    expect(buildHandoffMessage("/p", "abc", true)).toContain("resumes the SAME session again");
  });

  it("escapes HTML-significant characters in the path (goes into parse_mode HTML)", () => {
    const msg = buildHandoffMessage("/tmp/a & b", "abc", true);
    expect(msg).toContain("cd /tmp/a &amp; b &amp;&amp; claude --resume abc");
    expect(msg).not.toContain("/tmp/a & b &&");
  });

  it("wraps the command in a <pre> block for monospace + easy copy", () => {
    expect(buildHandoffMessage("/p", "abc", true)).toMatch(/<pre>cd \/p &amp;&amp; claude --resume abc<\/pre>/);
  });
});
