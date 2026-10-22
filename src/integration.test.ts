import { describe, it, expect } from "vitest";
import { homedir } from "os";
import { markdownToTelegramHtml, escapeHtml } from "./telegram-format.js";

describe("integration: markdown accumulation to Telegram HTML", () => {
  it("accumulates and converts multiple reply chunks", () => {
    let accumulated = "";
    accumulated += "Reading project structure...";
    accumulated += "\n\n";
    accumulated += "Found **3 files** in `src/`:";
    accumulated += "\n\n";
    accumulated += "- `index.ts`\n- `config.ts`\n- `main.ts`";

    const html = markdownToTelegramHtml(accumulated);
    expect(html).toContain("<b>3 files</b>");
    expect(html).toContain("<code>src/</code>");
    expect(html).toContain("<code>index.ts</code>");
  });

  it("handles long accumulated text", () => {
    const longContent = "x".repeat(2000);
    const text = longContent + "\n\n" + longContent + "\n\n" + longContent;

    expect(text.length).toBeGreaterThan(4096);

    // markdownToTelegramHtml should not crash on long text
    const html = markdownToTelegramHtml(text);
    expect(html.length).toBeGreaterThan(4096);
  });

  it("escapes HTML in non-formatted sections", () => {
    const text = "Error: expected `a < b` but got `a > b` in auth & session";
    const html = markdownToTelegramHtml(text);
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("<code>a &lt; b</code>");
  });
});

describe("/ls path resolution", () => {
  it("resolves empty arg to homedir", () => {
    const arg: string = "";
    const path = arg ? arg.replace(/^~/, homedir()) : homedir();
    expect(path).toBe(homedir());
  });

  it("resolves ~ to homedir", () => {
    const arg = "~";
    const path = arg ? arg.replace(/^~/, homedir()) : homedir();
    expect(path).toBe(homedir());
  });

  it("resolves ~/Work to homedir/Work", () => {
    const arg = "~/Work";
    const path = arg ? arg.replace(/^~/, homedir()) : homedir();
    expect(path).toBe(`${homedir()}/Work`);
  });
});
