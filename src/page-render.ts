/**
 * Self-contained, offline-renderable HTML for arbitrary markdown content —
 * the generalization of diff-render.ts's delivery shape (Telegram's in-app
 * browser loads nothing external, so all CSS is inlined and the template
 * references no URLs). Pure string in/out, no I/O.
 */
import { marked } from "marked";
import { escapeHtml } from "./telegram-format.js";

/** Documents past this stop being pleasant in Telegram's in-app browser —
 *  aligned with DIFF_HTML_MAX_PATCH_BYTES's rationale, halved because prose
 *  markdown expands in conversion where a patch renders ~1:1. */
export const PAGE_MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface PageMeta {
  title: string;
  projectName: string;
}

/** Filesystem/Telegram-safe filename stem from a page title: lowercase,
 *  diacritics stripped, anything outside [a-z0-9] collapsed to "-", capped.
 *  Never returns an empty string and never contains a path separator. */
export function slugifyPageTitle(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "page";
}

/**
 * Render markdown into a complete offline HTML document. Returns null for
 * blank content or content over PAGE_MAX_CONTENT_BYTES — the tool handler
 * turns that into an isError result telling Claude what to fix.
 */
export function renderPageHtml(markdown: string, meta: PageMeta): string | null {
  if (!markdown.trim()) return null;
  if (Buffer.byteLength(markdown, "utf8") > PAGE_MAX_CONTENT_BYTES) return null;

  let body: string;
  try {
    body = marked.parse(markdown, { async: false, gfm: true }) as string;
  } catch {
    return null;
  }

  const title = escapeHtml(meta.title);
  const project = escapeHtml(meta.projectName);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${title}</title>
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --ink: #1a202c; --muted: #64748b;
  --line: #e2e8f0; --accent: #2563eb; --code-bg: #f1f5f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: #171a21; --ink: #e5e9f0; --muted: #8b95a7;
    --line: #262b36; --accent: #60a5fa; --code-bg: #21262f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 20px 16px 44px; max-width: 720px;
  background: var(--bg); color: var(--ink);
  font: 16px/1.55 -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
}
.page-kicker { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
h1 { font-size: 25px; line-height: 1.25; margin: 0 0 14px; }
h2 { font-size: 19px; margin: 26px 0 8px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
p, ul, ol { margin: 0 0 12px; }
li { margin-bottom: 4px; }
a { color: var(--accent); }
hr { border: none; border-top: 1px solid var(--line); margin: 20px 0; }
blockquote { margin: 0 0 12px; padding: 8px 14px; border-left: 3px solid var(--accent); background: var(--card); border-radius: 0 8px 8px 0; color: var(--muted); }
code { font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; background: var(--code-bg); border-radius: 5px; padding: 1px 5px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 10px; padding: 12px; overflow-x: auto; margin: 0 0 12px; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0 0 14px; font-size: 14px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
th { background: var(--card); }
img { max-width: 100%; }
</style>
</head>
<body>
<div class="page-kicker">${project}</div>
<h1>${title}</h1>
${body}
</body>
</html>
`;
}

/** Input contract for the send_page MCP tool — mirrored by sendPageShape in
 *  tool-schemas.ts (asserted assignable in tool-schemas.test.ts). */
export interface SendPageInput {
  title: string;
  content: string;
  filename?: string;
}
