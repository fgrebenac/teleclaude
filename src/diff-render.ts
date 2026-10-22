/**
 * Self-contained, offline-renderable HTML for a git patch (Telegram's in-app
 * browser has no network access, so the diff2html CSS bundle is inlined into
 * the document rather than linked). Pure string in/out — no I/O beyond a
 * one-time, memoized read of diff2html's own CSS asset from node_modules.
 *
 * Paired with src/render-images.ts, which feeds this same HTML into puppeteer
 * for the paged-PNG preview — one HTML generator, two delivery shapes.
 */
import { createRequire } from "module";
import { readFileSync } from "fs";
import { html as diff2html } from "diff2html";
import { escapeHtml } from "./telegram-format.js";

/** Above this, Telegram's in-app browser struggles and the .patch/.html split
 *  stops paying for itself — skip the HTML attachment, keep the .patch. */
export const DIFF_HTML_MAX_PATCH_BYTES = 4 * 1024 * 1024;

let cachedCss: string | undefined;

/** Load diff2html's bundled CSS once per process. Falls back to "" (an
 *  unstyled but still-valid document) if the asset can't be found — never
 *  throws, since a missing stylesheet must not cost the whole diff preview. */
function loadDiff2htmlCss(): string {
  if (cachedCss !== undefined) return cachedCss;
  try {
    const require = createRequire(import.meta.url);
    const cssPath = require.resolve("diff2html/bundles/css/diff2html.min.css");
    cachedCss = readFileSync(cssPath, "utf8");
  } catch {
    cachedCss = "";
  }
  return cachedCss;
}

/** Reset the memoized CSS lookup (tests only). */
export function resetDiff2htmlCssCache(): void {
  cachedCss = undefined;
}

export interface DiffHtmlMeta {
  projectName: string;
  /** `git diff --stat` output, already available from collectGitDiff — shown
   *  above the file-by-file diff so the page doesn't require scrolling to see
   *  the shape of the change. */
  stat: string;
}

/**
 * Render `patch` (a `git diff` unified-diff string) into a complete HTML
 * document. Returns null for an empty patch or one over DIFF_HTML_MAX_PATCH_BYTES
 * — the caller falls back to the plain .patch attachment in both cases.
 */
export function renderDiffHtml(patch: string, meta: DiffHtmlMeta): string | null {
  if (!patch) return null;
  if (Buffer.byteLength(patch, "utf8") > DIFF_HTML_MAX_PATCH_BYTES) return null;

  let body: string;
  try {
    body = diff2html(patch, { drawFileList: true, matching: "lines", outputFormat: "line-by-line" });
  } catch {
    return null;
  }

  const css = loadDiff2htmlCss();
  const title = `${escapeHtml(meta.projectName)} — uncommitted diff`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${css}
body { margin: 0; padding: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #ffffff; color: #24292e; }
h1 { font-size: 15px; }
pre.diff-stat { white-space: pre-wrap; font-size: 12px; background: #f6f8fa; padding: 8px; border-radius: 4px; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #c9d1d9; }
  pre.diff-stat { background: #161b22; }
  .d2h-file-wrapper { border-color: #30363d; }
  .d2h-file-header { background-color: #161b22; color: #c9d1d9; }
  .d2h-code-line, .d2h-code-side-line, .d2h-code-linenumber { color: #c9d1d9; background: #0d1117; }
}
</style>
</head>
<body>
<h1>${title}</h1>
<pre class="diff-stat">${escapeHtml(meta.stat)}</pre>
${body}
</body>
</html>`;
}
