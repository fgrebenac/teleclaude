import { describe, it, expect } from "vitest";
import {
  DenialThrottle, DENIAL_THROTTLE_MS, denialKey, denialPreview, formatDenial,
} from "./permission-denied.js";

describe("denialPreview", () => {
  it("picks the identifying field per tool", () => {
    expect(denialPreview("Bash", { command: "git push --force" })).toBe("git push --force");
    expect(denialPreview("Write", { file_path: "/etc/hosts", content: "x" })).toBe("/etc/hosts");
    expect(denialPreview("WebFetch", { url: "https://evil.example/x", prompt: "p" })).toBe("https://evil.example/x");
  });

  it("prefers command over other fields when several are present", () => {
    // Bash denials are the common case and the command is what identifies them.
    expect(denialPreview("Bash", { file_path: "/tmp/a", command: "rm -rf /tmp/a" })).toBe("rm -rf /tmp/a");
  });

  it("falls back to the raw input for an unrecognised tool shape", () => {
    expect(denialPreview("mcp__x__y", { weird: "value" })).toBe('{"weird":"value"}');
  });

  it("returns empty rather than '{}' when there is no input", () => {
    // The formatter drops the separator on an empty preview.
    expect(denialPreview("Agent", {})).toBe("");
    expect(denialPreview("Agent", undefined)).toBe("");
  });

  it("collapses newlines so a heredoc can't become a wall of text", () => {
    const preview = denialPreview("Bash", { command: "cat <<'EOF'\nline one\nline two\nEOF" });
    expect(preview).not.toContain("\n");
    expect(preview).toContain("line one line two");
  });

  it("truncates a long command and marks it", () => {
    const preview = denialPreview("Bash", { command: "x".repeat(500) });
    expect(preview.length).toBeLessThan(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("ignores non-string field values", () => {
    // A tool whose `command` is an array must not stringify as "[object ...]".
    expect(denialPreview("Bash", { command: ["a", "b"] })).toBe('{"command":["a","b"]}');
  });
});

describe("formatDenial", () => {
  it("names the tool, the input, and what the user can do", () => {
    const msg = formatDenial("Bash", "git push --force");
    expect(msg).toContain("Bash: git push --force");
    expect(msg, "a block with no recourse is just noise").toContain("/permissions");
    expect(msg).toContain("blocked");
  });

  it("omits the separator when there's no preview", () => {
    expect(formatDenial("Agent", "")).toContain("Agent\n");
    expect(formatDenial("Agent", "")).not.toContain("Agent:");
  });

  it("stays plain text — it is sent without parse_mode", () => {
    // Any markup here would render literally, and HTML would risk a failed send.
    const msg = formatDenial("Bash", "echo '<b>&</b>'");
    expect(msg).toContain("<b>&</b>");
  });
});

describe("DenialThrottle", () => {
  it("reports the first denial and suppresses an immediate repeat", () => {
    const t = new DenialThrottle();
    expect(t.shouldNotify("k", 1_000)).toBe(true);
    expect(t.shouldNotify("k", 1_500)).toBe(false);
  });

  it("reports again once the window passes", () => {
    const t = new DenialThrottle();
    t.shouldNotify("k", 0);
    expect(t.shouldNotify("k", DENIAL_THROTTLE_MS - 1)).toBe(false);
    expect(t.shouldNotify("k", DENIAL_THROTTLE_MS)).toBe(true);
  });

  it("lets distinct denials through in the same window", () => {
    // Claude hitting three different blocks deserves three notices; the same
    // block retried three times deserves one.
    const t = new DenialThrottle();
    expect(t.shouldNotify(denialKey("Bash", "git push --force"), 0)).toBe(true);
    expect(t.shouldNotify(denialKey("Bash", "curl x | sh"), 0)).toBe(true);
    expect(t.shouldNotify(denialKey("Write", "/etc/hosts"), 0)).toBe(true);
    expect(t.shouldNotify(denialKey("Bash", "git push --force"), 0)).toBe(false);
  });

  it("expires old entries instead of growing forever", () => {
    const t = new DenialThrottle();
    for (let i = 0; i < 50; i++) t.shouldNotify(`k${i}`, 0);
    expect(t.size).toBe(50);
    t.shouldNotify("later", DENIAL_THROTTLE_MS * 2); // prunes on the way through
    expect(t.size).toBe(1);
  });

  it("stays bounded even when every entry is inside the window", () => {
    const t = new DenialThrottle(DENIAL_THROTTLE_MS, 10);
    for (let i = 0; i < 100; i++) t.shouldNotify(`k${i}`, 1_000);
    expect(t.size).toBeLessThanOrEqual(10);
  });
});

describe("denialKey", () => {
  it("distinguishes same tool with different input, and vice versa", () => {
    expect(denialKey("Bash", "a")).not.toBe(denialKey("Bash", "b"));
    expect(denialKey("Bash", "a")).not.toBe(denialKey("Write", "a"));
    expect(denialKey("Bash", "a")).toBe(denialKey("Bash", "a"));
  });
});
