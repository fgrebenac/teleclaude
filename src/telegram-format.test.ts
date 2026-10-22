import { describe, it, expect } from "vitest";
import { markdownToTelegramHtml, escapeHtml, splitText, stripMarkdown } from "./telegram-format.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("converts italic", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code blocks", () => {
    const result = markdownToTelegramHtml("```js\nconsole.log(1)\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("console.log(1)");
  });

  it("converts headings to bold", () => {
    expect(markdownToTelegramHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHtml("## Subtitle")).toBe("<b>Subtitle</b>");
  });

  it("converts links", () => {
    expect(markdownToTelegramHtml("[text](http://example.com)")).toBe('<a href="http://example.com">text</a>');
  });

  it("escapes double quotes so link hrefs cannot break", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
    expect(markdownToTelegramHtml('[x](https://e.com/p"w)'))
      .toBe('<a href="https://e.com/p&quot;w">x</a>');
  });

  it("keeps balanced parentheses inside link URLs", () => {
    expect(markdownToTelegramHtml("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"))
      .toBe('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>');
  });

  it("escapes HTML in non-formatted text", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toContain("&lt;");
    expect(markdownToTelegramHtml("a < b & c > d")).toContain("&amp;");
  });

  it("handles mixed formatting", () => {
    const result = markdownToTelegramHtml("**bold** and `code` and *italic*");
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("<code>code</code>");
    expect(result).toContain("<i>italic</i>");
  });

  it("returns escaped text on parse failure", () => {
    // Plain text should just be escaped
    const result = markdownToTelegramHtml("just plain text");
    expect(result).toBe("just plain text");
  });

  it("leaves pipe tables inside code fences verbatim", () => {
    const input = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(markdownToTelegramHtml(input)).toBe("<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>");
  });

  it("keeps the header row of small tables", () => {
    const out = markdownToTelegramHtml("| Name | Value |\n|---|---|\n| a | 1 |");
    expect(out).toContain("<b>Name — Value</b>");
    expect(out).toContain("• a — 1");
  });

  it("renders nested italic inside bold", () => {
    expect(markdownToTelegramHtml("**bold *nested* end**")).toBe("<b>bold <i>nested</i> end</b>");
  });

  it("treats a single asterisk inside bold as literal", () => {
    expect(markdownToTelegramHtml("**a * b = c**")).toBe("<b>a * b = c</b>");
  });

  it("still renders bold+italic and leaves plain italic/snake_case alone", () => {
    expect(markdownToTelegramHtml("***both***")).toBe("<b><i>both</i></b>");
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
    expect(markdownToTelegramHtml("snake_case")).toBe("snake_case");
  });
});

describe("escapeHtml", () => {
  it("escapes <, >, &", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe("&lt;script&gt;alert('xss')&lt;/script&gt;");
  });
});

describe("splitText", () => {
  it("returns single chunk when under the limit", () => {
    expect(splitText("short")).toEqual(["short"]);
  });

  it("splits at paragraph boundaries", () => {
    const para = "x".repeat(2000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3596);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("hard-cuts text with no break points", () => {
    const chunks = splitText("y".repeat(8000));
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe("y".repeat(8000));
  });

  it("never splits a surrogate pair at a hard cut", () => {
    const chunks = splitText("a" + "😀".repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true);
    expect(chunks.join("")).toBe("a" + "😀".repeat(4000));
  });

  it("closes and reopens code fences across split boundaries", () => {
    const body = Array.from({ length: 300 }, (_, i) => `const line_${i} = ${i};`).join("\n");
    const chunks = splitText("```ts\n" + body + "\n```");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      expect(html).toContain('<pre><code class="language-ts">');
      expect(html).not.toContain("```");
    }
  });

  it("does not add fences to plain text", () => {
    const text = ("para\n\n").repeat(600);
    for (const chunk of splitText(text)) expect(chunk).not.toContain("```");
  });

  it("stays in sync with an indented fence opener paired with a column-0 closer", () => {
    const prose = Array.from({ length: 300 }, (_, i) => `paragraph line ${i} of ordinary prose.`).join("\n");
    const text = "- item\n  ```ts\n  const x = 1;\n```\n\n" + prose;
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // The fence scanner must see the indented opener and the column-0 closer
    // as a matched pair, so nothing after them is treated as still-open —
    // no spurious ``` markers should appear in the trailing prose chunks.
    for (const chunk of chunks.slice(1)) expect(chunk).not.toContain("```");
  });
});

describe("stripMarkdown", () => {
  it("strips bold, code, and links", () => {
    expect(stripMarkdown("**bold** `code` [text](http://x)")).toBe("bold code text");
  });

  it("unwraps fenced code blocks", () => {
    expect(stripMarkdown("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("strips paren-URL links", () => {
    expect(stripMarkdown("[Foo](https://x.y/a_(b))")).toBe("Foo");
  });
});
