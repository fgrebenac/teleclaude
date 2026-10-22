import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProcessManager } from "./processes.js";
import type { LiveSessionInfo } from "./claude-session-registry.js";
import { autoNameDecision, maybeAutoName, type AutoNameState } from "./auto-name.js";

const DIR = "/tmp/teleclaude-test-auto-name";
const CHAT = -100123;
const TOPIC = 42;
const PID = 4242;

const derivedIdle: LiveSessionInfo = { pid: PID, name: "todo-c6", nameSource: "derived", status: "idle" };

describe("autoNameDecision", () => {
  const base = { enabled: true, live: derivedIdle };

  it("names an idle session still on Claude Code's placeholder", () => {
    expect(autoNameDecision(base)).toEqual({ go: true });
  });

  it("respects the config switch", () => {
    expect(autoNameDecision({ ...base, enabled: false })).toEqual({ go: false, reason: "disabled" });
  });

  it("leaves a name the user picked for this topic alone", () => {
    expect(autoNameDecision({ ...base, persistedName: "api work" })).toEqual({ go: false, reason: "named" });
  });

  it("leaves a session already named elsewhere alone (terminal /rename, restored on resume)", () => {
    expect(autoNameDecision({ ...base, live: { ...derivedIdle, nameSource: "user" } }))
      .toEqual({ go: false, reason: "named" });
    // nameSource is absent after some renames — absent is not "derived".
    expect(autoNameDecision({ ...base, live: { pid: PID, name: "x", status: "idle" } }))
      .toEqual({ go: false, reason: "named" });
  });

  it("never types into a busy session — the Enter could answer a permission dialog", () => {
    expect(autoNameDecision({ ...base, live: { ...derivedIdle, status: "busy" } }))
      .toEqual({ go: false, reason: "busy" });
    expect(autoNameDecision({ ...base, live: { ...derivedIdle, status: undefined } }))
      .toEqual({ go: false, reason: "busy" });
  });

  it("tries once per process", () => {
    expect(autoNameDecision({ ...base, attemptedPid: PID })).toEqual({ go: false, reason: "attempted" });
    // A respawn is a new pid — a fresh attempt.
    expect(autoNameDecision({ ...base, attemptedPid: PID - 1 })).toEqual({ go: true });
  });

  it("does nothing without a registry entry", () => {
    expect(autoNameDecision({ ...base, live: null })).toEqual({ go: false, reason: "no-registry" });
  });
});

describe("maybeAutoName", () => {
  function writeEntry(entry: Partial<LiveSessionInfo>): void {
    writeFileSync(join(DIR, `${PID}.json`), JSON.stringify({ ...derivedIdle, ...entry }));
  }

  function makePm(onRename: () => void = () => {}) {
    return {
      isRunning: vi.fn().mockReturnValue(true),
      getPid: vi.fn().mockReturnValue(PID),
      sendRenameCommand: vi.fn().mockImplementation(() => {
        onRename();
        return "sent";
      }),
    } as unknown as ProcessManager;
  }

  const opts = { enabled: true, timeoutMs: 300, intervalMs: 20, baseDir: DIR };

  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it("sends a bare /rename and returns the generated name", async () => {
    writeEntry({});
    const pm = makePm(() => setTimeout(() => writeEntry({ name: "fix-login-bug", nameSource: "user" }), 30));
    const state: AutoNameState = {};
    expect(await maybeAutoName(pm, CHAT, TOPIC, state, opts)).toBe("fix-login-bug");
    expect(pm.sendRenameCommand).toHaveBeenCalledWith(CHAT, TOPIC, undefined);
    expect(state.attemptedPid).toBe(PID);
  });

  it("does not retry a process whose rename never landed", async () => {
    writeEntry({});
    const pm = makePm();
    const state: AutoNameState = {};
    expect(await maybeAutoName(pm, CHAT, TOPIC, state, opts)).toBeUndefined();
    expect(await maybeAutoName(pm, CHAT, TOPIC, state, opts)).toBeUndefined();
    expect(pm.sendRenameCommand).toHaveBeenCalledTimes(1);
  });

  it("waits for a later turn when the session is busy, without spending its attempt", async () => {
    writeEntry({ status: "busy" });
    const pm = makePm();
    const state: AutoNameState = {};
    expect(await maybeAutoName(pm, CHAT, TOPIC, state, opts)).toBeUndefined();
    expect(pm.sendRenameCommand).not.toHaveBeenCalled();
    expect(state.attemptedPid).toBeUndefined();
  });

  it("does nothing for a topic with a persisted name", async () => {
    writeEntry({});
    const pm = makePm();
    expect(await maybeAutoName(pm, CHAT, TOPIC, {}, { ...opts, persistedName: "api work" })).toBeUndefined();
    expect(pm.sendRenameCommand).not.toHaveBeenCalled();
  });
});
