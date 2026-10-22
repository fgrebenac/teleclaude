import puppeteer, { type Page } from "puppeteer";
import { log } from "./log.js";

/** Upper bound on any single CDP command (navigation has its own 30s timeout). */
export const SCREENSHOT_PROTOCOL_TIMEOUT_MS = 60_000;

export interface ScreenshotOptions {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
}

/** Reject non-http(s) URLs — file:// would render local files into Telegram.
 *  (SSRF to localhost is intentional: screenshotting dev servers is the point.) */
function assertHttpUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed, got ${parsed.protocol}//`);
  }
}

/**
 * Shared puppeteer launch — one place for the launch args, so the diff-image
 * renderer (src/render-images.ts) can't drift from what's proven live here.
 */
export async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    // Puppeteer's default protocolTimeout is 180s; a stalled Page.captureScreenshot
    // (seen live when the Mac's display is asleep) would otherwise hold the tool
    // call well past Claude Code's 120s backgrounding and our stuck-tool watchdog.
    protocolTimeout: SCREENSHOT_PROTOCOL_TIMEOUT_MS,
    // --disable-gpu: new-headless Chrome on macOS never completes
    // Page.captureScreenshot while the display is asleep (reproduced 2026-10-22:
    // 41s timeout with the GPU process, ~1s without it, same page, same binary).
    // Software rendering has no such dependency on the display being awake.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}

/**
 * Take a screenshot of a URL and return the file path.
 */
export async function takeScreenshot(options: ScreenshotOptions): Promise<string> {
  const { url, width = 1280, height = 800, fullPage = false } = options;
  assertHttpUrl(url);
  const outputPath = `/tmp/teleclaude-screenshot-${Date.now()}.png`;

  log(`[screenshot] capturing ${url} (${width}x${height}, fullPage=${fullPage})`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.screenshot({ path: outputPath, fullPage });
    log(`[screenshot] saved to ${outputPath}`);
    return outputPath;
  } finally {
    await browser.close();
  }
}

// --- Browser interaction ---

export interface BrowseAction {
  action: "goto" | "click" | "type" | "wait" | "screenshot" | "scroll" | "select";
  url?: string;
  selector?: string;
  text?: string;
  seconds?: number;
  direction?: "up" | "down";
  pixels?: number;
}

export interface BrowseResult {
  screenshots: string[];
  log: string[];
}

/**
 * Execute a sequence of browser actions and return screenshots taken.
 */
export async function browse(actions: BrowseAction[], viewport = { width: 1280, height: 800 }): Promise<BrowseResult> {
  const browser = await launchBrowser();

  const result: BrowseResult = { screenshots: [], log: [] };

  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);

    for (const act of actions) {
      try {
        switch (act.action) {
          case "goto":
            if (!act.url) throw new Error("goto requires url");
            assertHttpUrl(act.url);
            await page.goto(act.url, { waitUntil: "networkidle2", timeout: 30_000 });
            result.log.push(`Navigated to ${act.url}`);
            break;

          case "click":
            if (!act.selector) throw new Error("click requires selector");
            await page.waitForSelector(act.selector, { timeout: 5000 });
            await page.click(act.selector);
            result.log.push(`Clicked ${act.selector}`);
            // Brief wait for any navigation/rendering
            await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
            break;

          case "type":
            if (!act.selector || !act.text) throw new Error("type requires selector and text");
            await page.waitForSelector(act.selector, { timeout: 5000 });
            await page.type(act.selector, act.text);
            result.log.push(`Typed "${act.text}" into ${act.selector}`);
            break;

          case "select":
            if (!act.selector || !act.text) throw new Error("select requires selector and text (value)");
            await page.waitForSelector(act.selector, { timeout: 5000 });
            await page.select(act.selector, act.text);
            result.log.push(`Selected "${act.text}" in ${act.selector}`);
            break;

          case "wait":
            const ms = (act.seconds ?? 1) * 1000;
            await new Promise((r) => setTimeout(r, ms));
            result.log.push(`Waited ${act.seconds ?? 1}s`);
            break;

          case "scroll": {
            const px = act.pixels ?? 500;
            const dir = act.direction === "up" ? -px : px;
            await page.evaluate((d) => window.scrollBy(0, d), dir);
            result.log.push(`Scrolled ${act.direction ?? "down"} ${px}px`);
            break;
          }

          case "screenshot": {
            const path = `/tmp/teleclaude-browse-${Date.now()}.png`;
            await page.screenshot({ path });
            result.screenshots.push(path);
            result.log.push(`Screenshot taken`);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.log.push(`Error on ${act.action}: ${msg}`);
      }
    }

    // Auto-screenshot at end if none were taken
    if (result.screenshots.length === 0) {
      const path = `/tmp/teleclaude-browse-${Date.now()}.png`;
      await page.screenshot({ path });
      result.screenshots.push(path);
      result.log.push("Auto-screenshot at end");
    }
  } finally {
    await browser.close();
  }

  return result;
}
