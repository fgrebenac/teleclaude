import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { loadConfig, saveConfig } from "./config.js";
import { startDaemon } from "./daemon.js";
import { versionString, packageVersion } from "./version.js";
import { LOG_PATH } from "./log.js";
import { channelServerCommand } from "./build-mode.js";

const TELECLAUDE_DIR = join(homedir(), ".teleclaude");
const LOG_DIR = join(TELECLAUDE_DIR, "logs");

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

// Service paths
const PLIST_PATH = join(homedir(), "Library/LaunchAgents/com.teleclaude.bot.plist");
const SYSTEMD_PATH = join(homedir(), ".config/systemd/user/teleclaude.service");

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "setup": await setup(); break;
    case "start": await start(); break;
    case "install": install(); break;
    case "uninstall": uninstall(); break;
    case "restart": restart(); break;
    case "update": await update(); break;
    case "status": status(); break;
    case "version": case "--version": case "-v": printVersion(); break;
    case "logs": logs(); break;
    case "doctor": await doctorCmd(); break;
    default:
      console.log("Usage: teleclaude <setup|start|install|uninstall|restart|update|status|version|logs|doctor>");
      break;
  }
}

async function setup(): Promise<void> {
  const config = loadConfig();
  const { parseOwnerIds, validateBotToken } = await import("./setup-validate.js");

  let botToken = "";
  for (let attempt = 1; attempt <= 3 && !botToken; attempt++) {
    const input = await ask("Telegram bot token (from @BotFather): ");
    const check = await validateBotToken(input);
    if (check.ok) {
      console.log(`✓ Token valid — bot is @${check.username}`);
      botToken = input.trim();
    } else {
      console.error(`✗ ${check.error}`);
    }
  }
  if (!botToken) {
    console.error("Giving up after 3 attempts. Nothing was saved.");
    process.exit(1);
  }

  let ids: number[] = [];
  for (let attempt = 1; attempt <= 3 && !ids.length; attempt++) {
    const raw = await ask("Authorized Telegram user ID(s), comma-separated (from @userinfobot): ");
    const parsed = parseOwnerIds(raw);
    if (parsed.ok) ids = parsed.ids;
    else console.error(`✗ ${parsed.error}`);
  }
  if (!ids.length) {
    console.error("Giving up after 3 attempts. Nothing was saved.");
    process.exit(1);
  }

  config.ownerTelegramId = ids[0];
  config.ownerTelegramIds = ids;
  saveConfig(config);

  if (!existsSync(TELECLAUDE_DIR)) mkdirSync(TELECLAUDE_DIR, { recursive: true });
  writeFileSync(join(TELECLAUDE_DIR, "bot_token"), botToken, { mode: 0o600 });

  console.log("Setup complete! Run 'teleclaude doctor' to verify your environment, then 'teleclaude start'.");
}

async function start(): Promise<void> {
  const tokenPath = join(TELECLAUDE_DIR, "bot_token");
  if (!existsSync(tokenPath)) {
    console.error("Bot token not found. Run 'teleclaude setup' first.");
    process.exit(1);
  }
  const token = readFileSync(tokenPath, "utf-8").trim();
  await startDaemon(token);
}

/** Bundled build ⇔ dist/channel-server.js sits next to the running file. */
function isPackagedBuild(): boolean {
  return channelServerCommand().command === "node";
}

/** Package root of the running tree: dist/.. for a bundled build, src/.. under tsx. */
const PACKAGE_ROOT = join(import.meta.dirname, "..");

/**
 * Pure computation of what a service file should launch. Kept separate from
 * the actual write/(un)load side effects so both dev and packaged shapes are
 * unit-testable without touching real launchd/systemd state.
 */
export interface ServiceLaunchInputs {
  npxPath: string;
  execPath: string;
  homeDir: string;
  cwd: string;
  packageRoot: string;
  fallbackPath: string;
  processEnvPath: string | undefined;
}

export interface ServiceLaunch {
  progArgs: string[];
  projectDir: string;
  envPath: string;
}

export function computeServiceLaunch(packaged: boolean, opts: ServiceLaunchInputs): ServiceLaunch {
  const projectDir = packaged ? opts.homeDir : opts.cwd;
  const envPath = packaged
    ? `${dirname(opts.execPath)}:${opts.fallbackPath}`
    : (opts.processEnvPath ?? opts.fallbackPath);
  const progArgs = packaged
    ? [opts.execPath, join(opts.packageRoot, "dist", "index.js"), "start"]
    : [opts.npxPath, "tsx", "src/index.ts", "start"];
  return { progArgs, projectDir, envPath };
}

export function buildPlist(progArgs: string[], projectDir: string, envPath: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.teleclaude.bot</string>
  <key>ProgramArguments</key>
  <array>
${progArgs.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${projectDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>`;
}

export function buildSystemdUnit(progArgs: string[], projectDir: string, envPath: string, home: string): string {
  return `[Unit]
Description=Teleclaude Telegram Bot
After=network.target

[Service]
Type=simple
ExecStart=${progArgs.join(" ")}
WorkingDirectory=${projectDir}
Environment=PATH=${envPath}
Environment=HOME=${home}
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
}

function install(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  if (IS_MACOS) {
    installMacOS();
  } else if (IS_LINUX) {
    installLinux();
  } else {
    console.error(`Unsupported platform: ${platform()}. Use 'teleclaude start' to run manually.`);
    process.exit(1);
  }
}

function installMacOS(): void {
  const packaged = isPackagedBuild();
  const npxPath = packaged ? "" : execSync("which npx").toString().trim();
  const { progArgs, projectDir, envPath } = computeServiceLaunch(packaged, {
    npxPath,
    execPath: process.execPath,
    homeDir: homedir(),
    cwd: process.cwd(),
    packageRoot: PACKAGE_ROOT,
    fallbackPath: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    processEnvPath: process.env.PATH,
  });

  const plist = buildPlist(progArgs, projectDir, envPath, homedir());

  try { execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`); } catch { /* ignore */ }
  // A brand-new macOS account has no ~/Library/LaunchAgents yet.
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist);
  execSync(`launchctl load ${PLIST_PATH}`);
  console.log("Teleclaude service installed (launchd).");
  console.log(`Logs: tail -f ${LOG_PATH}`);
}

function installLinux(): void {
  const packaged = isPackagedBuild();
  const npxPath = packaged ? "" : execSync("which npx").toString().trim();
  const { progArgs, projectDir, envPath } = computeServiceLaunch(packaged, {
    npxPath,
    execPath: process.execPath,
    homeDir: homedir(),
    cwd: process.cwd(),
    packageRoot: PACKAGE_ROOT,
    fallbackPath: "/usr/local/bin:/usr/bin:/bin",
    processEnvPath: process.env.PATH,
  });

  const service = buildSystemdUnit(progArgs, projectDir, envPath, homedir());

  const systemdDir = join(homedir(), ".config/systemd/user");
  mkdirSync(systemdDir, { recursive: true });
  writeFileSync(SYSTEMD_PATH, service);

  execSync("systemctl --user daemon-reload");
  execSync("systemctl --user enable teleclaude");
  execSync("systemctl --user start teleclaude");

  // A user service dies at logout unless lingering is enabled for the account.
  try {
    execSync(`loginctl enable-linger ${process.env.USER ?? execSync("whoami").toString().trim()}`);
    console.log("Enabled lingering — the service survives logout.");
  } catch {
    console.log("⚠️ Could not enable lingering. Run once: loginctl enable-linger $USER");
    console.log("   Without it, the bot stops when you log out of this machine.");
  }

  console.log("Teleclaude service installed (systemd user service).");
  console.log(`Logs: tail -f ${LOG_PATH}`);
  console.log("Status: systemctl --user status teleclaude");
}

function uninstall(): void {
  if (IS_MACOS && existsSync(PLIST_PATH)) {
    try { execSync(`launchctl unload ${PLIST_PATH}`); } catch {}
    unlinkSync(PLIST_PATH);
    console.log("Teleclaude service uninstalled (launchd).");
  } else if (IS_LINUX && existsSync(SYSTEMD_PATH)) {
    try {
      execSync("systemctl --user stop teleclaude");
      execSync("systemctl --user disable teleclaude");
    } catch {}
    unlinkSync(SYSTEMD_PATH);
    execSync("systemctl --user daemon-reload");
    console.log("Teleclaude service uninstalled (systemd).");
  } else {
    console.log("No service installed.");
  }
}

/** Restart the installed service in place. Returns false if no service is installed. */
function restartService(): boolean {
  if (IS_MACOS && existsSync(PLIST_PATH)) {
    const uid = execSync("id -u").toString().trim();
    execSync(`launchctl kickstart -k gui/${uid}/com.teleclaude.bot`, { stdio: "inherit" });
    return true;
  }
  if (IS_LINUX && existsSync(SYSTEMD_PATH)) {
    execSync("systemctl --user restart teleclaude", { stdio: "inherit" });
    return true;
  }
  return false;
}

function restart(): void {
  if (restartService()) {
    console.log("Teleclaude service restarted.");
  } else {
    console.log("No service installed. Use 'teleclaude install' first, or 'teleclaude start' to run manually.");
  }
}

/**
 * Pull the latest code, reinstall deps, and restart the service.
 * Run this from a terminal — NOT from within a Teleclaude chat, since restarting
 * the daemon kills the channel server hosting that chat.
 */
async function update(): Promise<void> {
  const projectDir = process.cwd();
  if (!existsSync(join(projectDir, ".git"))) {
    console.error("✗ Not a git checkout — 'teleclaude update' pulls from git. Reinstall a newer build instead.");
    process.exit(1);
  }
  const before = packageVersion();
  console.log(`Updating teleclaude in ${projectDir} (current ${versionString()})...`);

  // Refuse to clobber uncommitted work — ff-only keeps it safe and predictable.
  const dirty = execSync("git status --porcelain", { cwd: projectDir }).toString().trim();
  if (dirty) {
    console.error("✗ Working tree has uncommitted changes. Commit/stash them first, then re-run 'teleclaude update'.");
    process.exit(1);
  }

  try {
    console.log("→ git pull --ff-only");
    execSync("git pull --ff-only", { cwd: projectDir, stdio: "inherit" });
    console.log("→ npm install");
    execSync("npm install", { cwd: projectDir, stdio: "inherit" });
  } catch {
    console.error("✗ Update failed during pull/install. Service left untouched.");
    process.exit(1);
  }

  const after = packageVersion();
  if (restartService()) {
    console.log(`✓ Updated ${before} → ${after} and restarted the service.`);
  } else {
    console.log(`✓ Updated ${before} → ${after}. No service installed — run 'teleclaude start' (or 'install').`);
  }
}

function printVersion(): void {
  console.log(`teleclaude ${versionString()}`);
}

async function doctorCmd(): Promise<void> {
  // Thin adapter: doctor.ts holds the pure/injectable checks, this just
  // reads the real bot token off disk and prints the formatted report.
  const { runDoctor, formatResults } = await import("./doctor.js");
  const tokenPath = join(TELECLAUDE_DIR, "bot_token");
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : null;
  console.log(`teleclaude doctor — ${versionString()}\n`);
  const { results, ok } = await runDoctor(undefined, token);
  console.log(formatResults(results));
  console.log(ok ? "\nAll checks passed." : "\nSome checks failed — fix the ❌ items above and re-run.");
  process.exitCode = ok ? 0 : 1;
}

function status(): void {
  if (IS_MACOS) {
    try {
      const result = execSync("launchctl list com.teleclaude.bot 2>&1").toString();
      console.log(result);
    } catch {
      console.log("Service is not running.");
    }
  } else if (IS_LINUX) {
    try {
      const result = execSync("systemctl --user status teleclaude 2>&1").toString();
      console.log(result);
    } catch {
      console.log("Service is not running.");
    }
  } else {
    console.log(`Platform ${platform()} not supported for service management.`);
  }
}

function logs(): void {
  console.log(`Logs: tail -f ${LOG_PATH}`);
  execSync(`tail -f ${LOG_PATH}`, { stdio: "inherit" });
}
