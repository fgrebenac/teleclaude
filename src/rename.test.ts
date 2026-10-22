import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProcessManager } from "./processes.js";
import { requestRename, renameNotice } from "./rename.js";

const DIR = "/tmp/teleclaude-test-rename";
const CHAT = -100123;
const TOPIC = 42;
const PID = 4242;

function writeName(name: string, pid = PID): void {
  writeFileSync(join(DIR, `${pid}.json`), JSON.stringify({ pid, name, nameSource: "derived" }));
}

function makePm(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    isRunning: vi.fn().mockReturnValue(true),
    getPid: vi.fn().mockReturnValue(PID),
    sendRenameCommand: vi.fn().mockReturnValue("sent"),
    ...overrides,
  } as unknown as ProcessManager;
}

const opts = { timeoutMs: 300, intervalMs: 20, baseDir: DIR };

describe("requestRename", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("reports not-running without typing anything", async () => {
    const pm = makePm({ isRunning: vi.fn().mockReturnValue(false) });
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts)).toEqual({ status: "not-running" });
    expect(pm.sendRenameCommand).not.toHaveBeenCalled();
  });

  it("confirms the rename from Claude Code's registry", async () => {
    writeName("todo-c6");
    const pm = makePm({
      sendRenameCommand: vi.fn().mockImplementation(() => {
        // Claude Code rewrites the registry shortly after the keystrokes land.
        setTimeout(() => writeName("api work"), 40);
        return "sent";
      }),
    });
    const result = await requestRename(pm, CHAT, TOPIC, "api work", opts);
    expect(result).toEqual({ status: "confirmed", name: "api work" });
    expect(pm.sendRenameCommand).toHaveBeenCalledWith(CHAT, TOPIC, "api work");
  });

  it("reports the name Claude Code actually chose when it adjusts the request", async () => {
    writeName("todo-c6");
    const pm = makePm({
      sendRenameCommand: vi.fn().mockImplementation(() => {
        setTimeout(() => writeName("api-work-2"), 40);
        return "sent";
      }),
    });
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts))
      .toEqual({ status: "adjusted", name: "api-work-2" });
  });

  it("reads back the name a bare /rename generated", async () => {
    writeName("todo-c6");
    const pm = makePm({
      sendRenameCommand: vi.fn().mockImplementation(() => {
        setTimeout(() => writeName("fix-login-bug"), 40);
        return "sent";
      }),
    });
    const result = await requestRename(pm, CHAT, TOPIC, undefined, opts);
    expect(result).toEqual({ status: "confirmed", name: "fix-login-bug" });
    expect(pm.sendRenameCommand).toHaveBeenCalledWith(CHAT, TOPIC, undefined);
  });

  it("does not claim success when the registry never changes", async () => {
    writeName("todo-c6");
    const pm = makePm();
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts))
      .toEqual({ status: "unconfirmed", name: "todo-c6" });
  });

  it("is unconfirmed, not confirmed, when there is no pid to verify against", async () => {
    const pm = makePm({ getPid: vi.fn().mockReturnValue(undefined) });
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts)).toEqual({ status: "unconfirmed" });
    // The keystrokes still went out — the process may be alive without a pid we
    // can key the registry on.
    expect(pm.sendRenameCommand).toHaveBeenCalled();
  });

  it("reports not-running if the process dies between the check and the write", async () => {
    const pm = makePm({ sendRenameCommand: vi.fn().mockReturnValue("not-running") });
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts)).toEqual({ status: "not-running" });
  });

  it("returns fast when the requested name is already the current one", async () => {
    writeName("api work");
    const pm = makePm();
    const started = Date.now();
    expect(await requestRename(pm, CHAT, TOPIC, "api work", opts))
      .toEqual({ status: "confirmed", name: "api work" });
    // Must not wait out the poll timeout for a request that's already satisfied.
    expect(Date.now() - started).toBeLessThan(opts.timeoutMs);
  });
});

describe("renameNotice", () => {
  it("escapes the name — it is user text going into an HTML message", () => {
    // An unescaped < or & makes Telegram reject the send, so the notice never
    // arrives at all.
    const notice = renameNotice({ status: "confirmed", name: "a<b & c" }, "a<b & c");
    expect(notice).toContain("a&lt;b &amp; c");
    expect(notice).not.toContain("a<b");
  });

  it("names both the requested and the actual name when adjusted", () => {
    const notice = renameNotice({ status: "adjusted", name: "api-work-2" }, "api work");
    expect(notice).toContain("api-work-2");
    expect(notice).toContain("api work");
  });

  it("says the name was saved for the next session when nothing is running", () => {
    expect(renameNotice({ status: "not-running" }, "api work")).toContain("next session");
  });

  it("points at /rename <name> when there is nothing to auto-name", () => {
    expect(renameNotice({ status: "not-running" }, undefined)).toContain("/rename");
  });

  it("does not claim a rename it could not confirm", () => {
    const notice = renameNotice({ status: "unconfirmed" }, "api work");
    expect(notice).toContain("couldn't confirm");
    expect(notice).not.toContain("renamed to");
  });
});
