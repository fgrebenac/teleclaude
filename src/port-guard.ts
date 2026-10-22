import { execSync } from "child_process";
import { log } from "./log.js";

/**
 * A channel server is a `channel-server.ts` (dev, `npx tsx`) or bundled
 * `channel-server.js` (packaged, plain `node`) subprocess spawned by Claude
 * Code, not by us — teleclaude never holds its pid, so identity has to come
 * from the command line. The script filename is unique to teleclaude; a
 * customer's dev server on the same port will never contain either literal.
 * Matching only the .ts source left a bundled orphan looking "foreign" —
 * never swept, so the port stayed burned across every packaged respawn.
 */
export function isTeleclaudeChannelServer(commandLine: string): boolean {
  return commandLine.includes("channel-server.ts") || commandLine.includes("channel-server.js");
}

export type PortSweepResult = "free" | "cleared" | "foreign";

/** Injectable so sweep decisions are unit-testable without real processes. */
export interface PortSweepDeps {
  listPids: (port: number) => number[];
  commandOf: (pid: number) => string;
  kill: (pid: number) => void;
}

export const defaultPortSweepDeps: PortSweepDeps = {
  listPids: (port) => {
    try {
      const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      return out ? out.split("\n").map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    } catch {
      return []; // lsof exits non-zero when the port is unused
    }
  },
  commandOf: (pid) => {
    try {
      return execSync(`ps -o command= -p ${pid}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    } catch {
      return ""; // process already gone — unidentifiable, so treated as foreign
    }
  },
  kill: (pid) => {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  },
};

/**
 * Free a channel-server port WITHOUT harming anything we didn't start.
 * Kills only pids whose command line is recognizably our channel server;
 * returns "foreign" if any other process holds the port — the caller must
 * pick a different port, never kill. Replaces the old killPort(), which
 * SIGKILLed every listener unconditionally and would take out a customer's
 * unrelated dev server sitting on 8801.
 */
export function sweepPort(port: number, deps: PortSweepDeps = defaultPortSweepDeps): PortSweepResult {
  const pids = deps.listPids(port);
  if (pids.length === 0) return "free";
  const ours = pids.filter((pid) => isTeleclaudeChannelServer(deps.commandOf(pid)));
  for (const pid of ours) {
    deps.kill(pid);
    log(`[port] killed orphan channel server pid=${pid} on :${port}`);
  }
  const foreign = pids.length - ours.length;
  if (foreign > 0) {
    log(`[port] :${port} held by ${foreign} non-teleclaude process(es) — leaving them alone`);
    return "foreign";
  }
  return "cleared";
}
