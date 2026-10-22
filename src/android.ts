import * as cp from "child_process";
import { log } from "./log.js";

export type AndroidAction =
  | { action: "launch"; avd?: string }
  | { action: "install"; apk: string }
  | { action: "open"; url: string }
  | { action: "screenshot" }
  | { action: "tap"; x: number; y: number }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { action: "type"; text: string }
  | { action: "key"; keycode: string }
  | { action: "shell"; command: string }
  | { action: "wait"; seconds: number };

export interface AndroidResult {
  screenshots: string[];
  log: string[];
}

function execAdb(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile("adb", args, { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("adb not found — install Android SDK and add platform-tools to PATH"));
        } else {
          reject(err);
        }
        return;
      }
      resolve(stdout as string);
    });
  });
}

function adb(args: string[], serial?: string): Promise<string> {
  return execAdb(serial ? ["-s", serial, ...args] : args);
}

export async function findRunningEmulator(): Promise<string | null> {
  const out = await execAdb(["devices"]);
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0]?.startsWith("emulator-") && parts[1] === "device") return parts[0];
  }
  return null;
}

async function getFirstAvd(): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile("avdmanager", ["list", "avd", "-c"], { encoding: "utf8" }, (err, stdout) => {
      if (err) { reject(err); return; }
      const name = (stdout as string).trim().split("\n")[0]?.trim();
      if (!name) reject(new Error('No AVDs found — create one: avdmanager create avd -n Pixel_7 -k "system-images;android-34;google_apis;arm64-v8a"'));
      else resolve(name);
    });
  });
}

async function waitForBoot(serial: string, timeoutMs = 120_000): Promise<void> {
  await adb(["wait-for-device"], serial);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = await adb(["shell", "getprop", "sys.boot_completed"], serial);
      if (out.trim() === "1") return;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Emulator boot timed out after 120s");
}

export async function androidAction(actions: AndroidAction[], serial?: string): Promise<AndroidResult> {
  const result: AndroidResult = { screenshots: [], log: [] };

  for (const act of actions) {
    try {
      switch (act.action) {
        case "launch": {
          const existing = await findRunningEmulator();
          if (existing) {
            serial = existing;
            result.log.push(`Reused running emulator ${existing}`);
            break;
          }
          const avd = act.avd ?? await getFirstAvd();
          log(`[android] launching AVD: ${avd}`);
          cp.spawn("emulator", ["-avd", avd, "-no-window", "-no-audio"], { detached: true, stdio: "ignore" }).unref();
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const found = await findRunningEmulator();
            if (found) { serial = found; break; }
            await new Promise(r => setTimeout(r, 2000));
          }
          if (!serial) throw new Error("Emulator did not appear in adb devices after 30s");
          await waitForBoot(serial);
          result.log.push(`Launched emulator ${serial} (AVD: ${avd})`);
          break;
        }
        case "install": {
          if (!serial) throw new Error("No emulator running — add a launch action first");
          await adb(["install", "-r", act.apk], serial);
          result.log.push(`Installed ${act.apk}`);
          break;
        }
        case "open": {
          if (!serial) throw new Error("No emulator running — add a launch action first");
          await adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", act.url], serial);
          result.log.push(`Opened ${act.url}`);
          break;
        }
        case "screenshot": {
          if (!serial) throw new Error("No emulator running — add a launch action first");
          const path = `/tmp/teleclaude-android-${Date.now()}.png`;
          await adb(["shell", "screencap", "-p", "/sdcard/_tc_screen.png"], serial);
          await adb(["pull", "/sdcard/_tc_screen.png", path], serial);
          result.screenshots.push(path);
          result.log.push("Screenshot taken");
          break;
        }
        case "tap": {
          if (!serial) throw new Error("No emulator running");
          await adb(["shell", "input", "tap", String(act.x), String(act.y)], serial);
          result.log.push(`Tapped ${act.x},${act.y}`);
          break;
        }
        case "swipe": {
          if (!serial) throw new Error("No emulator running");
          await adb(["shell", "input", "swipe",
            String(act.x1), String(act.y1), String(act.x2), String(act.y2),
            String(act.duration ?? 300)], serial);
          result.log.push(`Swiped (${act.x1},${act.y1})→(${act.x2},${act.y2})`);
          break;
        }
        case "type": {
          if (!serial) throw new Error("No emulator running");
          // adb shell input text requires spaces as %s; the arg also passes
          // through the DEVICE shell, so metacharacters must be escaped or
          // quotes/&/; in the text get interpreted instead of typed.
          const escaped = act.text
            .replace(/([\\'"`$&|;()<>*?!#~[\]{}])/g, "\\$1")
            .replace(/ /g, "%s");
          await adb(["shell", "input", "text", escaped], serial);
          result.log.push(`Typed "${act.text}"`);
          break;
        }
        case "key": {
          if (!serial) throw new Error("No emulator running");
          await adb(["shell", "input", "keyevent", act.keycode], serial);
          result.log.push(`Key ${act.keycode}`);
          break;
        }
        case "shell": {
          if (!serial) throw new Error("No emulator running");
          // Pass entire command string as single arg — device shell interprets it.
          // Simple commands (ls, pm, am) work fine. Pipes/redirects (e.g. cat f | grep x) also
          // work because the device shell parses them, but host-side shell features won't apply.
          const out = await adb(["shell", act.command], serial);
          result.log.push(`shell: ${out.trim().slice(0, 200)}`);
          break;
        }
        case "wait": {
          await new Promise(r => setTimeout(r, act.seconds * 1000));
          result.log.push(`Waited ${act.seconds}s`);
          break;
        }
      }
    } catch (err) {
      // Re-throw setup/configuration errors so the caller knows what to fix
      if (err instanceof Error && err.message.startsWith("adb not found")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result.log.push(`Error on ${act.action}: ${msg}`);
    }
  }

  // Auto-screenshot at end if none taken and emulator is running
  if (result.screenshots.length === 0 && serial) {
    try {
      const path = `/tmp/teleclaude-android-${Date.now()}.png`;
      await adb(["shell", "screencap", "-p", "/sdcard/_tc_screen.png"], serial);
      await adb(["pull", "/sdcard/_tc_screen.png", path], serial);
      result.screenshots.push(path);
      result.log.push("Auto-screenshot at end");
    } catch { /* ignore — emulator may not support screencap */ }
  }

  return result;
}
