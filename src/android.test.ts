import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cp from "child_process";

vi.mock("child_process");

describe("findRunningEmulator", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns null when no emulators listed", async () => {
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(null, "List of devices attached\n\n", "");
      return {} as any;
    });
    const { findRunningEmulator } = await import("./android.js");
    expect(await findRunningEmulator()).toBeNull();
  });

  it("returns serial when emulator is running", async () => {
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(null, "List of devices attached\nemulator-5554\tdevice\n", "");
      return {} as any;
    });
    const { findRunningEmulator } = await import("./android.js");
    expect(await findRunningEmulator()).toBe("emulator-5554");
  });
});

describe("androidAction", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("dispatches tap as adb shell input tap", async () => {
    const execFile = vi.mocked(cp.execFile);
    execFile.mockImplementation((_c, _a, _o, cb: any) => { cb(null, "", ""); return {} as any; });
    const { androidAction } = await import("./android.js");
    await androidAction([{ action: "tap", x: 100, y: 200 }], "emulator-5554");
    const argsUsed = execFile.mock.calls.map(c => (c[1] as string[]).join(" "));
    expect(argsUsed.some(a => a.includes("input tap 100 200"))).toBe(true);
  });

  it("throws with setup instructions when adb not found", async () => {
    vi.mocked(cp.execFile).mockImplementationOnce((_c, _a, _o, cb: any) => {
      cb(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "");
      return {} as any;
    });
    const { androidAction } = await import("./android.js");
    await expect(androidAction([{ action: "tap", x: 0, y: 0 }], "emulator-5554"))
      .rejects.toThrow("adb not found");
  });

  it("waits when action is wait", async () => {
    vi.useFakeTimers();
    const { androidAction } = await import("./android.js");
    const p = androidAction([{ action: "wait", seconds: 2 }], "emulator-5554");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await p;
    expect(result.log).toContain("Waited 2s");
    vi.useRealTimers();
  });
});
