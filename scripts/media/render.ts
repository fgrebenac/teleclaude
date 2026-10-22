/**
 * Renders the README/launch illustrations into .github/media/.
 *
 *   npx tsx scripts/media/render.ts
 *
 * Every piece of bot text goes through teleclaude's real formatters — tool
 * lines via formatToolActivity, the live/collapsed turn via TurnView, reply
 * markdown via markdownToTelegramHtml, the pinned bar via pinText — so the
 * illustrations show exactly what a topic displays. The chat chrome around it
 * is a generic dark messenger UI, and the projects/messages are demo content.
 *
 * Needs ffmpeg on PATH for the GIF/MP4 output.
 */
import puppeteer, { type Page } from "puppeteer";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TurnView, makeFingerprint } from "../../src/turn-view.js";
import { formatToolActivity } from "../../src/tool-activity.js";
import { markdownToTelegramHtml, escapeHtml } from "../../src/telegram-format.js";
import { pinText } from "../../src/session-pin.js";

const OUT = join(import.meta.dirname, "..", "..", ".github", "media");
const SCALE = 2;
const PHONE = { width: 390, height: 700 };
const GIF_WIDTH = 600;

// --- Chat model -------------------------------------------------------------

interface Bubble {
  from: "user" | "bot";
  html: string;
  buttons?: string[][];
  time?: string;
}

interface ChatScreen {
  kind: "chat";
  title: string;
  subtitle: string;
  pinned?: string;
  bubbles: Bubble[];
}

interface ListRow {
  icon: string;
  color: string;
  title: string;
  preview: string;
  time?: string;
  badge?: number;
}

interface ListScreen {
  kind: "list";
  title: string;
  subtitle?: string;
  back?: boolean;
  rows: ListRow[];
  highlight?: number;
}

type Screen = ChatScreen | ListScreen;

const userText = (text: string, time = "09:41"): Bubble => ({ from: "user", html: escapeHtml(text), time });
const botText = (markdown: string, buttons?: string[][], time = "09:41"): Bubble =>
  ({ from: "bot", html: markdownToTelegramHtml(markdown), buttons, time });

// --- HTML -------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  #phone { width: ${PHONE.width}px; height: ${PHONE.height}px; background: #0e1621; color: #f5f5f5;
    display: flex; flex-direction: column; overflow: hidden; border-radius: 28px; }
  .status { height: 34px; padding: 0 26px; display: flex; align-items: center; justify-content: space-between;
    font-size: 14px; font-weight: 600; background: #17212b; }
  .header { background: #17212b; padding: 6px 14px 10px; display: flex; align-items: center; gap: 12px;
    border-bottom: 1px solid #0b1118; }
  .back { color: #6ab3f3; font-size: 26px; line-height: 1; width: 14px; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 17px; color: #fff; flex: none; }
  .htitle { font-size: 16.5px; font-weight: 600; }
  .hsub { font-size: 13px; color: #708499; margin-top: 2px; }
  .hsub.typing { color: #6ab3f3; }
  .pinned { background: #17212b; padding: 7px 16px; border-left: 3px solid #6ab3f3; margin: 0;
    font-size: 13.5px; border-bottom: 1px solid #0b1118; }
  .pinned .lbl { color: #6ab3f3; font-weight: 600; font-size: 12.5px; }
  .chat { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; padding: 10px 10px 8px; }
  .row { display: flex; flex-direction: column; }
  .row.user { align-items: flex-end; }
  .row.bot { align-items: flex-start; }
  .bubble { max-width: 86%; padding: 7px 11px 6px; border-radius: 15px; font-size: 15px; line-height: 1.36;
    white-space: pre-wrap; word-wrap: break-word; }
  .user .bubble { background: #2b5278; border-bottom-right-radius: 5px; }
  .bot .bubble { background: #182533; border-bottom-left-radius: 5px; }
  .name { color: #6ab3f3; font-weight: 600; font-size: 13.5px; margin-bottom: 2px; }
  .time { float: right; font-size: 11.5px; color: #6d8299; margin: 6px 0 -2px 10px; }
  .user .time { color: #7da8d3; }
  .bubble code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13.5px; color: #e9a96e; }
  .bubble pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #0e1621;
    border-radius: 7px; padding: 7px 9px; margin: 2px 0; white-space: pre-wrap; color: #cfd8e3; }
  .bubble b { font-weight: 650; }
  .buttons { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; width: 86%; }
  .brow { display: flex; gap: 4px; }
  .btn { flex: 1; text-align: center; background: #1f3346; border-radius: 9px; padding: 9px 6px; font-size: 14.5px; font-weight: 500; }
  .composer { background: #17212b; padding: 9px 12px 22px; display: flex; gap: 10px; align-items: center; }
  .input { flex: 1; background: #0e1621; border-radius: 18px; padding: 9px 14px; color: #6d7f8f; font-size: 15px; }
  .list { flex: 1; background: #0e1621; }
  .lrow { display: flex; gap: 12px; align-items: center; padding: 9px 14px; }
  .lrow.hl { background: #202b36; }
  .ltext { flex: 1; min-width: 0; border-bottom: 1px solid #101921; padding-bottom: 9px; margin-bottom: -9px; }
  .ltop { display: flex; justify-content: space-between; align-items: baseline; }
  .ltitle { font-size: 16px; font-weight: 600; }
  .ltime { font-size: 12.5px; color: #6d7f8f; }
  .lprev { font-size: 14.5px; color: #8696a5; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; justify-content: space-between; gap: 8px; }
  .lprev span { overflow: hidden; text-overflow: ellipsis; }
  .badge { background: #3e6a92; color: #fff; border-radius: 11px; font-size: 12.5px; font-weight: 600; padding: 1px 7px; flex: none; }
  .hash { font-size: 22px; font-weight: 700; }
`;

const statusBar = `<div class="status"><span>9:41</span><span>100%</span></div>`;

function chatHtml(s: ChatScreen): string {
  const typing = s.subtitle.includes("typing");
  const bubbles = s.bubbles.map((b) => {
    const name = b.from === "bot" ? `<div class="name">teleclaude</div>` : "";
    const time = b.time ? `<span class="time">${b.time}</span>` : "";
    const buttons = b.buttons
      ? `<div class="buttons">${b.buttons.map((r) => `<div class="brow">${r.map((t) => `<div class="btn">${t}</div>`).join("")}</div>`).join("")}</div>`
      : "";
    return `<div class="row ${b.from}"><div class="bubble">${name}${b.html}${time}</div>${buttons}</div>`;
  }).join("");
  return `${statusBar}
    <div class="header"><div class="back">‹</div>
      <div class="avatar" style="background:#3e6a92"><span class="hash">#</span></div>
      <div><div class="htitle">${escapeHtml(s.title)}</div><div class="hsub${typing ? " typing" : ""}">${escapeHtml(s.subtitle)}</div></div>
    </div>
    ${s.pinned ? `<div class="pinned"><div class="lbl">Pinned message</div>${escapeHtml(s.pinned)}</div>` : ""}
    <div class="chat">${bubbles}</div>
    <div class="composer"><div class="input">Message</div></div>`;
}

function listHtml(s: ListScreen): string {
  const rows = s.rows.map((r, i) => `
    <div class="lrow${s.highlight === i ? " hl" : ""}">
      <div class="avatar" style="background:${r.color}">${r.icon}</div>
      <div class="ltext">
        <div class="ltop"><span class="ltitle">${escapeHtml(r.title)}</span><span class="ltime">${r.time ?? ""}</span></div>
        <div class="lprev"><span>${escapeHtml(r.preview)}</span>${r.badge ? `<span class="badge">${r.badge}</span>` : ""}</div>
      </div>
    </div>`).join("");
  return `${statusBar}
    <div class="header">${s.back ? `<div class="back">‹</div>` : ""}
      <div><div class="htitle">${escapeHtml(s.title)}</div>${s.subtitle ? `<div class="hsub">${escapeHtml(s.subtitle)}</div>` : ""}</div>
    </div>
    <div class="list">${rows}</div>`;
}

const page = (s: Screen) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div id="phone">${s.kind === "chat" ? chatHtml(s) : listHtml(s)}</div></body></html>`;

async function shoot(p: Page, s: Screen, file: string): Promise<void> {
  await p.setContent(page(s), { waitUntil: "load" });
  const el = await p.$("#phone");
  await el!.screenshot({ path: file, omitBackground: true });
}

// --- Scenes -----------------------------------------------------------------

/** The demo turn, frame by frame, driven through the real TurnView. */
function demoFrames(): { screen: ChatScreen; hold: number }[] {
  const ask = "add a dark mode toggle to the header";
  const pin = pinText("dark-mode-toggle", "opus");
  const view = new TurnView();
  view.phaseCollapse = true;
  let now = 1_000_000;
  view.turnStarted(now);

  const frames: { screen: ChatScreen; hold: number }[] = [];
  const snap = (hold: number, live: string | null, typing = true, extra: Bubble[] = []) => {
    const bubbles: Bubble[] = [userText(ask)];
    if (live) bubbles.push(botText(live));
    bubbles.push(...extra);
    frames.push({ screen: { kind: "chat", title: "blog", subtitle: typing ? "Personal · teleclaude is typing…" : "Personal", pinned: pin, bubbles }, hold });
  };

  const tool = (name: string, input: Record<string, unknown>, hold: number, agentId?: string) => {
    const line = formatToolActivity(name, input);
    if (line) view.toolStarted({ toolName: name, fingerprint: makeFingerprint(name, input), line, agentId });
    now += hold * 4000;
    snap(hold, view.render());
  };
  const done = (name: string, input: Record<string, unknown>, ms: number, hold: number, agentId?: string) => {
    view.toolFinished({ toolName: name, fingerprint: makeFingerprint(name, input), ok: true, durationMs: ms, agentId });
    snap(hold, view.render());
  };

  snap(0.9, null, false);
  snap(0.8, null, true);
  tool("Read", { file_path: "src/components/Header.tsx" }, 0.6);
  tool("Read", { file_path: "src/styles/theme.css" }, 0.6);
  tool("Edit", { file_path: "src/styles/theme.css" }, 0.6);
  tool("Write", { file_path: "src/components/ThemeToggle.tsx" }, 0.6);
  tool("Edit", { file_path: "src/components/Header.tsx" }, 0.6);
  view.agentStarted("a1", "general-purpose");
  view.agentLabel("a1", "check contrast in both themes");
  snap(0.8, view.render());
  tool("Read", { file_path: "src/styles/theme.css" }, 0.6, "a1");
  view.agentStopped("a1", "All text meets WCAG AA in light and dark.");
  snap(0.8, view.render());
  const test = { command: "npm test" };
  tool("Bash", test, 0.7);
  done("Bash", test, 6200, 0.9);
  const build = { command: "npm run build" };
  tool("Bash", build, 0.7);
  done("Bash", build, 4100, 0.9);

  view.closePhase(
    "Added a dark mode toggle to the header.\n\n" +
    "• `ThemeToggle` button next to the nav links\n" +
    "• colors moved to CSS variables in `theme.css`, with a `[data-theme=\"dark\"]` override\n" +
    "• the choice is saved in `localStorage` and defaults to the system setting\n\n" +
    "Tests and build pass.",
    now,
  );
  now += 3000;
  snap(1.6, view.renderFull());
  view.noteDone(now);
  snap(4.0, view.renderFinal("summary", now), false);
  return frames;
}

function permissionScreen(): ChatScreen {
  const view = new TurnView();
  view.phaseCollapse = true;
  view.turnStarted(0);
  const du = { command: "du -sh /var/log/* | sort -h | tail -5" };
  view.toolStarted({ toolName: "Bash", fingerprint: makeFingerprint("Bash", du), line: formatToolActivity("Bash", du)! });
  view.toolFinished({ toolName: "Bash", fingerprint: makeFingerprint("Bash", du), ok: true, durationMs: 2300 });
  const prompt = `🔐 <b>Bash</b>\n\n${escapeHtml("Delete rotated logs older than 30 days")}\n\n<pre>${escapeHtml("find /var/log -name '*.gz' -mtime +30 -delete")}</pre>`;
  return {
    kind: "chat", title: "home-server", subtitle: "Personal · teleclaude is typing…",
    pinned: pinText("disk-cleanup", "sonnet"),
    bubbles: [
      userText("the server is almost out of disk, free some space"),
      botText(view.render()),
      { from: "bot", html: prompt, buttons: [["✅ Allow", "❌ Deny"]], time: "09:42" },
    ],
  };
}

function groupsFrames(): { screen: ListScreen; hold: number }[] {
  const chats: ListScreen = {
    kind: "list", title: "Chats",
    rows: [
      { icon: "P", color: "#5a8fd6", title: "Personal", preview: "blog: Added a dark mode toggle to the header.", time: "09:41", badge: 1 },
      { icon: "W", color: "#d67a4a", title: "Work", preview: "api: All 214 tests pass.", time: "09:12" },
      { icon: "T", color: "#4aa37a", title: "teleclaude", preview: "✅ → blog", time: "Tue" },
    ],
  };
  const personal: ListScreen = {
    kind: "list", title: "Personal", subtitle: "4 topics", back: true,
    rows: [
      { icon: "#", color: "#4b5b6b", title: "General", preview: "✅ Project \"blog\" created.", time: "Mon" },
      { icon: "#", color: "#3e6a92", title: "blog", preview: "Added a dark mode toggle to the header.", time: "09:41", badge: 1 },
      { icon: "#", color: "#3e6a92", title: "recipes", preview: "Imported 12 recipes from the PDF.", time: "Sun" },
      { icon: "#", color: "#3e6a92", title: "home-server", preview: "Freed 18 GB — rotated logs older than 30 days.", time: "Sat" },
    ],
  };
  const work: ListScreen = {
    kind: "list", title: "Work", subtitle: "3 topics", back: true,
    rows: [
      { icon: "#", color: "#4b5b6b", title: "General", preview: "⏰ Scheduled a3f9", time: "Mon" },
      { icon: "#", color: "#3e6a92", title: "api", preview: "All 214 tests pass.", time: "09:12" },
      { icon: "#", color: "#3e6a92", title: "web-app", preview: "Opened the PR for the signup form fix.", time: "Yesterday" },
    ],
  };
  return [
    { screen: chats, hold: 1.4 },
    { screen: { ...chats, highlight: 0 }, hold: 0.35 },
    { screen: personal, hold: 2.4 },
    { screen: chats, hold: 0.9 },
    { screen: { ...chats, highlight: 1 }, hold: 0.35 },
    { screen: work, hold: 2.4 },
  ];
}

// --- Output -----------------------------------------------------------------

function encode(frames: { file: string; hold: number }[], dir: string, name: string): void {
  const list = frames.map((f) => `file '${f.file}'\nduration ${f.hold}`).join("\n") + `\nfile '${frames.at(-1)!.file}'\n`;
  const listPath = join(dir, `${name}.txt`);
  writeFileSync(listPath, list);
  // One GIF frame per state (vfr) with its own delay, instead of resampling
  // to a fixed rate — most states are static, so this keeps the GIF small.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none`,
    "-fps_mode", "vfr", "-loop", "0", join(OUT, `${name}.gif`)]);
  const scale = `scale=${PHONE.width * SCALE}:-1:flags=lanczos`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=30,${scale},format=yuv420p`, "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart",
    join(OUT, `${name}.mp4`)]);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "teleclaude-media-"));
  const browser = await puppeteer.launch();
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: PHONE.width + 20, height: PHONE.height + 20, deviceScaleFactor: SCALE });

    const demo = demoFrames();
    const demoFiles = [];
    for (const [i, f] of demo.entries()) {
      const file = join(tmp, `demo-${String(i).padStart(3, "0")}.png`);
      await shoot(p, f.screen, file);
      demoFiles.push({ file, hold: f.hold });
    }
    encode(demoFiles, tmp, "demo");
    // A mid-turn frame (running agent + tool lines) doubles as the live-view still.
    const liveIdx = demo.findIndex((f) => f.screen.bubbles.some((b) => b.html.includes("— running")));
    await shoot(p, demo[liveIdx].screen, join(OUT, "live.png"));

    await shoot(p, permissionScreen(), join(OUT, "permissions.png"));

    const groups = groupsFrames();
    const groupFiles = [];
    for (const [i, f] of groups.entries()) {
      const file = join(tmp, `groups-${i}.png`);
      await shoot(p, f.screen, file);
      groupFiles.push({ file, hold: f.hold });
    }
    encode(groupFiles, tmp, "groups");
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`wrote media to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
