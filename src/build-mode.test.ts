import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { channelServerCommand } from "./build-mode.js";

describe("channelServerCommand", () => {
  it("launches the bundled channel-server.js with plain node when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-build-"));
    writeFileSync(join(dir, "channel-server.js"), "// bundle");
    expect(channelServerCommand(dir)).toEqual({
      command: "node",
      args: [join(dir, "channel-server.js")],
    });
  });

  it("falls back to npx tsx on the .ts source in a dev checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-build-"));
    expect(channelServerCommand(dir)).toEqual({
      command: "npx",
      args: ["tsx", join(dir, "channel-server.ts")],
    });
  });
});
