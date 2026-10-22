import { describe, it, expect } from "vitest";
import {
  computeServiceLaunch, buildPlist, buildSystemdUnit,
  type ServiceLaunchInputs,
} from "./cli.js";

// Fixed inputs shared by dev/packaged cases so every test exercises the same
// "machine" and only `packaged` varies.
const BASE_OPTS: ServiceLaunchInputs = {
  npxPath: "/usr/local/bin/npx",
  execPath: "/usr/local/bin/node",
  homeDir: "/Users/tester",
  cwd: "/Users/tester/teleclaude",
  packageRoot: "/Users/tester/teleclaude",
  fallbackPath: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  processEnvPath: "/usr/bin:/bin",
};

describe("computeServiceLaunch", () => {
  it("dev mode: npx tsx src/index.ts start, cwd as WorkingDirectory, inherits process.env.PATH", () => {
    const r = computeServiceLaunch(false, BASE_OPTS);
    expect(r).toEqual({
      progArgs: ["/usr/local/bin/npx", "tsx", "src/index.ts", "start"],
      projectDir: "/Users/tester/teleclaude",
      envPath: "/usr/bin:/bin",
    });
  });

  it("dev mode falls back to the fallback PATH when process.env.PATH is unset", () => {
    const r = computeServiceLaunch(false, { ...BASE_OPTS, processEnvPath: undefined });
    expect(r.envPath).toBe(BASE_OPTS.fallbackPath);
  });

  it("packaged mode: node <packageRoot>/dist/index.js start, home dir as WorkingDirectory", () => {
    const r = computeServiceLaunch(true, BASE_OPTS);
    expect(r).toEqual({
      progArgs: ["/usr/local/bin/node", "/Users/tester/teleclaude/dist/index.js", "start"],
      projectDir: "/Users/tester",
      envPath: "/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    });
  });

  it("packaged mode PATH is dirname(execPath) + system dirs, NOT the installer shell's whole $PATH", () => {
    const r = computeServiceLaunch(true, {
      ...BASE_OPTS,
      processEnvPath: "/some/weird/installer/only/path:/tmp/whatever",
    });
    expect(r.envPath).toBe("/usr/local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(r.envPath).not.toContain("/some/weird/installer");
  });
});

describe("buildPlist — dev output pinned byte-identical to today's format", () => {
  it("matches the exact template shape for dev args", () => {
    const { progArgs, projectDir, envPath } = computeServiceLaunch(false, BASE_OPTS);
    const plist = buildPlist(progArgs, projectDir, envPath, BASE_OPTS.homeDir);
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.teleclaude.bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npx</string>
    <string>tsx</string>
    <string>src/index.ts</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/tester/teleclaude</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/tester</string>
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
    expect(plist).toBe(expected);
  });
});

describe("buildPlist — packaged shape", () => {
  it("ProgramArguments = [execPath, <packageRoot>/dist/index.js, start]; WorkingDirectory = home", () => {
    const { progArgs, projectDir, envPath } = computeServiceLaunch(true, BASE_OPTS);
    const plist = buildPlist(progArgs, projectDir, envPath, BASE_OPTS.homeDir);
    expect(plist).toContain("    <string>/usr/local/bin/node</string>\n    <string>/Users/tester/teleclaude/dist/index.js</string>\n    <string>start</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/Users/tester</string>");
    expect(plist).not.toContain("tsx");
    expect(plist).not.toContain("npx");
  });
});

describe("buildSystemdUnit — dev output pinned byte-identical to today's format", () => {
  it("matches the exact unit shape for dev args", () => {
    const { progArgs, projectDir, envPath } = computeServiceLaunch(false, BASE_OPTS);
    const unit = buildSystemdUnit(progArgs, projectDir, envPath, BASE_OPTS.homeDir);
    const expected = `[Unit]
Description=Teleclaude Telegram Bot
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/npx tsx src/index.ts start
WorkingDirectory=/Users/tester/teleclaude
Environment=PATH=/usr/bin:/bin
Environment=HOME=/Users/tester
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
    expect(unit).toBe(expected);
  });
});

describe("buildSystemdUnit — packaged shape", () => {
  it("ExecStart = node <packageRoot>/dist/index.js start; WorkingDirectory = home", () => {
    const { progArgs, projectDir, envPath } = computeServiceLaunch(true, BASE_OPTS);
    const unit = buildSystemdUnit(progArgs, projectDir, envPath, BASE_OPTS.homeDir);
    expect(unit).toContain("ExecStart=/usr/local/bin/node /Users/tester/teleclaude/dist/index.js start");
    expect(unit).toContain("WorkingDirectory=/Users/tester");
    expect(unit).not.toContain("tsx");
  });
});
