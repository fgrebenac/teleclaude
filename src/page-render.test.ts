import { describe, expect, it } from "vitest";
import { PAGE_MAX_CONTENT_BYTES, renderPageHtml, slugifyPageTitle } from "./page-render.js";

const meta = { title: "Weekly report", projectName: "teleclaude" };

describe("renderPageHtml", () => {
  it("renders markdown into a complete offline document", () => {
    const html = renderPageHtml("# Hello\n\nSome **bold** text.", meta);
    expect(html).not.toBeNull();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });

  it("renders tables and fenced code", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```";
    const html = renderPageHtml(md, meta)!;
    expect(html).toContain("<table>");
    expect(html).toContain("<pre><code");
  });

  it("escapes the title", () => {
    const html = renderPageHtml("hi", { ...meta, title: "a <b> & c" })!;
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).not.toContain("<title>a <b>");
  });

  it("includes a CSP meta tag disallowing scripts and outbound requests", () => {
    const html = renderPageHtml("# Plain\n\nNo links here.", meta)!;
    expect(html).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">',
    );
  });

  it("references no external URLs from the template", () => {
    // Telegram's in-app browser loads nothing external — the template must be
    // fully self-contained (same invariant as diff-render.test.ts).
    const html = renderPageHtml("# Plain\n\nNo links here.", meta)!;
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("returns null for empty or oversized content", () => {
    expect(renderPageHtml("", meta)).toBeNull();
    expect(renderPageHtml("   \n  ", meta)).toBeNull();
    expect(renderPageHtml("x".repeat(PAGE_MAX_CONTENT_BYTES + 1), meta)).toBeNull();
  });
});

describe("slugifyPageTitle", () => {
  it("lowercases, strips diacritics, collapses separators", () => {
    expect(slugifyPageTitle("Crème & Café: report!")).toBe("creme-cafe-report");
  });
  it("falls back to 'page' when nothing survives", () => {
    expect(slugifyPageTitle("")).toBe("page");
    expect(slugifyPageTitle("!!!")).toBe("page");
  });
  it("caps length and never emits path separators", () => {
    const slug = slugifyPageTitle("a/b\\c " + "long ".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toMatch(/[/\\]/);
  });
});
