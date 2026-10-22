import * as cp from "child_process";
import { log } from "./log.js";

export type IosAction =
  | { action: "boot"; udid?: string }
  | { action: "install"; ipa: string }
  | { action: "launch"; bundleId: string }
  | { action: "open"; url: string }
  | { action: "screenshot" }
  | { action: "tap"; x: number; y: number }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; duration?: number }
  | { action: "type"; text: string }
  | { action: "key"; keycode: string }
  | { action: "shell"; command: string }
  | { action: "wait"; seconds: number };

export interface IosResult {
  screenshots: string[];
  log: string[];
}

function execCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          const hint = cmd === "idb"
            ? "brew install facebook/fb/idb-companion && pip3 install fb-idb"
            : "xcode-select --install";
          reject(new Error(`${cmd} not found — ${hint}`));
        } else {
          reject(err);
        }
        return;
      }
      resolve(stdout as string);
    });
  });
}

function simctl(args: string[]): Promise<string> {
  return execCmd("xcrun", ["simctl", ...args]);
}

function idbCmd(args: string[]): Promise<string> {
  return execCmd("idb", args);
}

export async function findBootedSimulator(): Promise<string | null> {
  const out = await simctl(["list", "devices", "booted", "-j"]);
  const data = JSON.parse(out) as {
    devices: Record<string, Array<{ udid: string; state: string }>>;
  };
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === "Booted") return d.udid;
    }
  }
  return null;
}

async function getFirstAvailableSimulator(): Promise<string> {
  const out = await simctl(["list", "devices", "available", "-j"]);
  const data = JSON.parse(out) as {
    devices: Record<string, Array<{ udid: string; name: string; isAvailable: boolean }>>;
  };
  for (const [runtime, devices] of Object.entries(data.devices)) {
    if (!runtime.toLowerCase().includes("ios")) continue;
    const iphone = devices.find(d => d.isAvailable !== false && d.name.includes("iPhone"));
    if (iphone) return iphone.udid;
  }
  throw new Error(
    "No available iPhone simulator — create one in Xcode → Window → Devices and Simulators",
  );
}

export async function iosAction(actions: IosAction[], udid?: string): Promise<IosResult> {
  const result: IosResult = { screenshots: [], log: [] };

  for (const act of actions) {
    try {
      switch (act.action) {
        case "boot": {
          const existing = await findBootedSimulator();
          if (existing) {
            udid = existing;
            result.log.push(`Reused booted simulator ${existing}`);
            break;
          }
          const targetUdid = act.udid ?? await getFirstAvailableSimulator();
          log(`[ios] booting simulator: ${targetUdid}`);
          await simctl(["boot", targetUdid]);
          udid = targetUdid;
          result.log.push(`Booted simulator ${udid}`);
          break;
        }
        case "install": {
          if (!udid) throw new Error("No simulator booted — add a boot action first");
          await simctl(["install", udid, act.ipa]);
          result.log.push(`Installed ${act.ipa}`);
          break;
        }
        case "launch": {
          if (!udid) throw new Error("No simulator booted — add a boot action first");
          await simctl(["launch", udid, act.bundleId]);
          result.log.push(`Launched ${act.bundleId}`);
          break;
        }
        case "open": {
          if (!udid) throw new Error("No simulator booted — add a boot action first");
          await simctl(["openurl", udid, act.url]);
          result.log.push(`Opened ${act.url}`);
          break;
        }
        case "screenshot": {
          if (!udid) throw new Error("No simulator booted — add a boot action first");
          const path = `/tmp/teleclaude-ios-${Date.now()}.png`;
          await simctl(["io", udid, "screenshot", path]);
          result.screenshots.push(path);
          result.log.push("Screenshot taken");
          break;
        }
        // Interaction commands live under the "ui" subcommand: `idb ui tap X Y`,
        // `idb ui swipe ...`, `idb ui text ...`, `idb ui button NAME`.
        case "tap": {
          if (!udid) throw new Error("No simulator booted");
          await idbCmd(["ui", "tap", String(act.x), String(act.y), "--udid", udid]);
          result.log.push(`Tapped ${act.x},${act.y}`);
          break;
        }
        case "swipe": {
          if (!udid) throw new Error("No simulator booted");
          const dur = String((act.duration ?? 300) / 1000);
          await idbCmd([
            "ui", "swipe",
            String(act.x1), String(act.y1),
            String(act.x2), String(act.y2),
            "--duration", dur,
            "--udid", udid,
          ]);
          result.log.push(`Swiped (${act.x1},${act.y1})→(${act.x2},${act.y2})`);
          break;
        }
        case "type": {
          if (!udid) throw new Error("No simulator booted");
          await idbCmd(["ui", "text", act.text, "--udid", udid]);
          result.log.push(`Typed "${act.text}"`);
          break;
        }
        case "key": {
          if (!udid) throw new Error("No simulator booted");
          await idbCmd(["ui", "button", act.keycode, "--udid", udid]);
          result.log.push(`Key ${act.keycode}`);
          break;
        }
        case "shell": {
          if (!udid) throw new Error("No simulator booted");
          const out = await simctl(["spawn", udid, "/bin/sh", "-c", act.command]);
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
      // Only rethrow OUR tooling-missing errors — a bare .includes("not found")
      // also matched ordinary simctl output like "device not found" and aborted
      // the whole action list.
      if (err instanceof Error && (err.message.startsWith("idb not found") || err.message.startsWith("xcrun not found"))) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result.log.push(`Error on ${act.action}: ${msg}`);
    }
  }

  // Auto-screenshot at end if none taken and simulator is running
  if (result.screenshots.length === 0 && udid) {
    try {
      const path = `/tmp/teleclaude-ios-${Date.now()}.png`;
      await simctl(["io", udid, "screenshot", path]);
      result.screenshots.push(path);
      result.log.push("Auto-screenshot at end");
    } catch { /* ignore */ }
  }

  return result;
}
