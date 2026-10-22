/**
 * Render a self-contained HTML document (from src/diff-render.ts) into paged
 * PNG screenshots for a Telegram media-group album. `renderHtmlToImages` is
 * puppeteer-backed and MUST NEVER be called from a test — no test in this repo
 * may launch a browser (npm test runs on the live dev machine on every
 * `npm version`). `pageClips` carries the paging math's test coverage instead.
 */
import { launchBrowser } from "./screenshot.js";
import { log } from "./log.js";

export const DEFAULT_WIDTH = 900;
export const DEFAULT_PAGE_HEIGHT = 2200;
export const DEFAULT_MAX_PAGES = 10;

export interface RenderImagesOptions {
  width?: number;
  pageHeightPx?: number;
  maxPages?: number;
}

export interface PageClip {
  y: number;
  height: number;
}

/**
 * Pure paging math: slice `[0, totalHeight)` into at most `maxPages` clips of
 * `pageHeight`, with the final clip clamped to the remaining content so it
 * never captures blank space past the page. Exported so the slicing logic has
 * full test coverage without ever launching a browser.
 */
export function pageClips(totalHeight: number, pageHeight: number, maxPages: number): PageClip[] {
  if (totalHeight <= 0 || pageHeight <= 0 || maxPages <= 0) return [];
  const clips: PageClip[] = [];
  let y = 0;
  while (y < totalHeight && clips.length < maxPages) {
    clips.push({ y, height: Math.min(pageHeight, totalHeight - y) });
    y += pageHeight;
  }
  return clips;
}

/**
 * Render `html` to a sequence of PNG files on disk, one per page. Returns the
 * file paths in order; the caller is responsible for sending and then
 * deleting them (see sendDiffImagePreview in handlers/commands.ts).
 */
export async function renderHtmlToImages(html: string, opts: RenderImagesOptions = {}): Promise<string[]> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const pageHeight = opts.pageHeightPx ?? DEFAULT_PAGE_HEIGHT;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: pageHeight });
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    const clips = pageClips(totalHeight, pageHeight, maxPages);
    const stamp = Date.now();
    const paths: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const outPath = `/tmp/teleclaude-diffimg-${stamp}-${i + 1}.png`;
      await page.screenshot({ path: outPath, clip: { x: 0, y: clip.y, width, height: clip.height } });
      paths.push(outPath);
    }
    log(`[render-images] rendered ${paths.length} page(s) of ${totalHeight}px total height`);
    return paths;
  } finally {
    await browser.close();
  }
}
