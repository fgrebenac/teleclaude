/**
 * Convert standard markdown to Telegram HTML.
 * Only handles what Telegram supports: bold, italic, code, code blocks,
 * strikethrough, links, blockquotes. Everything else passes through as text.
 */
export function markdownToTelegramHtml(text: string): string {
  try {
    return convert(text);
  } catch {
    // If conversion fails, return escaped plain text
    return escapeHtml(text);
  }
}

/** Convert markdown pipe tables to readable list format for Telegram. */
function convertTables(text: string): string {
  return text.replace(
    /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_match, headerRow: string, _sep: string, bodyBlock: string) => {
      const headers = headerRow.split("|").slice(1, -1).map((h: string) => h.trim());
      const rows = bodyBlock.trim().split("\n").map((row: string) =>
        row.split("|").slice(1, -1).map((cell: string) => cell.trim()),
      );

      const lines: string[] = [];
      if (headers.length <= 2) {
        const headerParts = headers.filter((h: string) => h);
        if (headerParts.length > 0) lines.push(`**${headerParts.join(" — ")}**`);
      }
      for (const cells of rows) {
        if (headers.length <= 2) {
          // 1-2 columns: "• key — value"
          const parts = cells.filter((c: string) => c);
          lines.push(`• ${parts.join(" — ")}`);
        } else {
          // 3+ columns: "• **first col** — header: value, header: value"
          const rest = cells.slice(1)
            .map((c: string, i: number) => `${headers[i + 1]}: ${c}`)
            .filter((s: string) => !s.endsWith(": "));
          lines.push(`• **${cells[0]}** — ${rest.join(" · ")}`);
        }
      }
      return lines.join("\n");
    },
  );
}

function convert(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks FIRST — nothing below may rewrite code content
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`,
    );
    return `\x00CB${i}\x00`;
  });

  // 2. Extract inline code
  result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
    const i = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${i}\x00`;
  });

  // 3. Convert tables — now guaranteed to be outside any code block
  result = convertTables(result);

  // 4. Escape HTML in the rest
  result = escapeHtml(result);

  // 5. Inline formatting (non-greedy, single-line only)
  // Bold+italic: ***text***
  result = result.replace(/\*\*\*([^\n*]+)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold: **text** — content may contain single asterisks (nested italic or
  // a literal *), just never a closing **. The italic pass below then
  // converts any *span* left inside the <b> content.
  result = result.replace(/\*\*((?:[^\n*]|\*(?!\*))+)\*\*/g, "<b>$1</b>");
  // Italic: *text* (but not inside words like file*name)
  result = result.replace(/(?<!\w)\*([^\n*]+)\*(?!\w)/g, "<i>$1</i>");
  // Strikethrough: ~~text~~
  result = result.replace(/~~([^\n~]+)~~/g, "<s>$1</s>");
  // Links: [text](url) — URL may contain one level of balanced parens (wiki URLs)
  result = result.replace(/\[([^\]]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, '<a href="$2">$1</a>');
  // Blockquotes: > text
  result = result.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  result = result.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // 6. Headings → bold (Telegram has no headings)
  result = result.replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");

  // 7. Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[parseInt(i)]);

  // 8. Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[parseInt(i)]);

  return result;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const MAX_MSG_LEN = 4096;
// Conservative limit for raw text: HTML tags add overhead (code blocks, bold, etc.)
// Using a buffer ensures the HTML version stays under Telegram's 4096-char limit.
export const HTML_SAFE_LEN = MAX_MSG_LEN - 500;

/** Strip markdown syntax for readable plain-text fallback (no `**bold**` artifacts). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\w]*\n([\s\S]*?)```/g, (_, code: string) => code.trim())
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*\*([^\n*]+)\*\*\*/g, "$1")
    // Bold: **text** — mirrors the renderer's rule so a nested *span* or a
    // literal single * inside bold doesn't leave stray ** behind. Nested
    // spans are then cleaned by the italic rule that follows.
    .replace(/\*\*((?:[^\n*]|\*(?!\*))+)\*\*/g, "$1")
    .replace(/(?<!\w)\*([^\n*]+)\*(?!\w)/g, "$1")
    .replace(/~~([^\n~]+)~~/g, "$1")
    .replace(/^#{1,6} /gm, "")
    .replace(/\[([^\]]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g, "$1");
}

/** A fence delimiter line: ``` optionally followed by a language tag.
 *  Allows leading whitespace (an indented fence inside a list item) to stay
 *  in sync with convert()'s fence extractor, which matches indented fences
 *  too — a mismatch here desyncs the split-time scanner from the renderer.
 *  The language capture is bounded (24 chars) so a pathological run of
 *  word-chars after ``` can't be carried as a giant "language" prefix onto
 *  every split chunk. */
const FENCE_LINE = /^\s*```(\w{0,24})\s*$/;

/** Returns the open fence's language ("" = no tag) if `text` ends inside a
 *  fenced block, else null. */
function scanOpenFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = FENCE_LINE.exec(line);
    if (m) open = open === null ? m[1] : null;
  }
  return open;
}

/** Close a fence left open at each chunk boundary and reopen it (with its
 *  language) at the start of the next chunk — Telegram parses every message
 *  independently, so each chunk must balance its own fences. The ~500-unit
 *  headroom between HTML_SAFE_LEN and MAX_MSG_LEN absorbs the added lines. */
function rebalanceFences(chunks: string[]): string[] {
  let carry: string | null = null;
  return chunks.map((chunk) => {
    let c = carry !== null ? "```" + carry + "\n" + chunk : chunk;
    carry = scanOpenFence(c);
    if (carry !== null) c += "\n```";
    return c;
  });
}

/** Split text into chunks that fit Telegram's limit, preferring paragraph boundaries. */
export function splitText(text: string): string[] {
  if (text.length <= HTML_SAFE_LEN) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > HTML_SAFE_LEN) {
    // Try to split at double newline (paragraph)
    let cut = rest.lastIndexOf("\n\n", HTML_SAFE_LEN);
    // Fall back to single newline
    if (cut < HTML_SAFE_LEN / 2) cut = rest.lastIndexOf("\n", HTML_SAFE_LEN);
    // Fall back to space
    if (cut < HTML_SAFE_LEN / 2) cut = rest.lastIndexOf(" ", HTML_SAFE_LEN);
    // Hard cut as last resort
    if (cut < HTML_SAFE_LEN / 2) cut = HTML_SAFE_LEN;
    // Never split a surrogate pair: if the unit before the cut is a high
    // surrogate, the pair straddles the boundary — back off one unit. (A lone
    // surrogate in EITHER chunk makes Telegram reject the send, and it survives
    // the plain-text fallback too — this was the audit's only total-loss path.)
    if ((rest.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut -= 1;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return rebalanceFences(chunks);
}
