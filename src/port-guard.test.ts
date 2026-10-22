import { describe, it, expect } from "vitest";
import { isTeleclaudeChannelServer, sweepPort, type PortSweepDeps } from "./port-guard.js";

describe("isTeleclaudeChannelServer", () => {
  it("recognizes our channel server however tsx is invoked", () => {
    expect(isTeleclaudeChannelServer("npx tsx /Users/x/Work/teleclaude/src/channel-server.ts")).toBe(true);
    expect(isTeleclaudeChannelServer("node /Users/x/.npm/_npx/123/node_modules/.bin/tsx src/channel-server.ts")).toBe(true);
  });

  it("recognizes the bundled channel-server.js run by plain node (packaged install)", () => {
    expect(isTeleclaudeChannelServer("node /Users/x/.teleclaude/app/current/dist/channel-server.js")).toBe(true);
  });

  it("rejects everything else that might listen on 88xx", () => {
    expect(isTeleclaudeChannelServer("python -m http.server 8801")).toBe(false);
    expect(isTeleclaudeChannelServer("node server.js")).toBe(false);
    expect(isTeleclaudeChannelServer("vite --port 8801")).toBe(false);
    expect(isTeleclaudeChannelServer("")).toBe(false);
  });
});

function fakeDeps(listeners: Record<number, string>): PortSweepDeps & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    listPids: () => Object.keys(listeners).map(Number),
    commandOf: (pid) => listeners[pid] ?? "",
    kill: (pid) => { killed.push(pid); },
  };
}

describe("sweepPort", () => {
  it("returns free when nothing listens", () => {
    const deps = fakeDeps({});
    expect(sweepPort(8801, deps)).toBe("free");
    expect(deps.killed).toEqual([]);
  });

  it("kills orphaned channel servers and reports cleared", () => {
    const deps = fakeDeps({ 111: "npx tsx /x/src/channel-server.ts" });
    expect(sweepPort(8801, deps)).toBe("cleared");
    expect(deps.killed).toEqual([111]);
  });

  it("NEVER kills a foreign listener — kills only ours and reports foreign", () => {
    const deps = fakeDeps({
      111: "npx tsx /x/src/channel-server.ts",
      222: "python -m http.server 8801",
    });
    expect(sweepPort(8801, deps)).toBe("foreign");
    expect(deps.killed).toEqual([111]);
  });

  it("leaves an all-foreign port completely untouched", () => {
    const deps = fakeDeps({ 222: "vite --port 8801" });
    expect(sweepPort(8801, deps)).toBe("foreign");
    expect(deps.killed).toEqual([]);
  });
});
