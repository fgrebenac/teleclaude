import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cp from "child_process";

vi.mock("child_process");

describe("findBootedSimulator", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns null when no simulators booted", async () => {
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(null, JSON.stringify({ devices: {} }), "");
      return {} as any;
    });
    const { findBootedSimulator } = await import("./ios.js");
    expect(await findBootedSimulator()).toBeNull();
  });

  it("returns udid when simulator is booted", async () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
          { udid: "TEST-UDID-123", state: "Booted", name: "iPhone 15" },
        ],
      },
    });
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(null, json, "");
      return {} as any;
    });
    const { findBootedSimulator } = await import("./ios.js");
    expect(await findBootedSimulator()).toBe("TEST-UDID-123");
  });
});

describe("iosAction", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("dispatches tap via idb with coordinates and udid", async () => {
    const execFile = vi.mocked(cp.execFile);
    execFile.mockImplementation((_c, _a, _o, cb: any) => { cb(null, "", ""); return {} as any; });
    const { iosAction } = await import("./ios.js");
    await iosAction([{ action: "tap", x: 100, y: 200 }], "TEST-UDID");
    const argsUsed = execFile.mock.calls.map(c => (c[1] as string[]).join(" "));
    expect(argsUsed.some(a => a.includes("tap") && a.includes("100") && a.includes("200"))).toBe(true);
  });

  it("throws with setup instructions when idb not found", async () => {
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "");
      return {} as any;
    });
    const { iosAction } = await import("./ios.js");
    await expect(iosAction([{ action: "tap", x: 0, y: 0 }], "TEST-UDID"))
      .rejects.toThrow("idb not found");
  });

  it("waits when action is wait", async () => {
    vi.useFakeTimers();
    const { iosAction } = await import("./ios.js");
    const p = iosAction([{ action: "wait", seconds: 2 }], "TEST-UDID");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await p;
    expect(result.log).toContain("Waited 2s");
    vi.useRealTimers();
  });
});
