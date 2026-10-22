import { describe, it, expect } from "vitest";
import {
  DEFAULT_PERMISSION_MODE, PERMISSION_MODES, permissionModeArgs, permissionModeHelp,
  permissionModeLabel, permissionModeShort, parsePermissionMode, resolvePermissionMode,
  type PermissionMode,
} from "./permission-mode.js";

describe("resolvePermissionMode", () => {
  it("defaults to auto — the whole point of the migration", () => {
    // The old default was bypass=true, i.e. --dangerously-skip-permissions on
    // every topic that had never been configured. That's the case this changes.
    expect(resolvePermissionMode(undefined)).toBe("auto");
    expect(resolvePermissionMode({})).toBe("auto");
    expect(DEFAULT_PERMISSION_MODE).toBe("auto");
  });

  it("honours an explicit permissionMode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(resolvePermissionMode({ permissionMode: mode })).toBe(mode);
    }
  });

  it("honours a legacy /bypass choice rather than silently overriding it", () => {
    expect(resolvePermissionMode({ bypass: true })).toBe("bypass");
    expect(resolvePermissionMode({ bypass: false })).toBe("default");
  });

  it("prefers permissionMode over the legacy boolean", () => {
    expect(resolvePermissionMode({ permissionMode: "auto", bypass: true })).toBe("auto");
    expect(resolvePermissionMode({ permissionMode: "bypass", bypass: false })).toBe("bypass");
  });

  it("falls back to the default on a garbage persisted value", () => {
    // A hand-edited or future-version sessions.json must not brick a topic.
    expect(resolvePermissionMode({ permissionMode: "yolo" as PermissionMode })).toBe("auto");
  });
});

describe("permissionModeArgs", () => {
  it("passes auto mode explicitly", () => {
    expect(permissionModeArgs("auto")).toEqual(["--permission-mode", "auto"]);
  });

  it("is always explicit, so a user-level defaultMode can't change a topic's mode", () => {
    // Every mode emits a flag — none relies on Claude Code's own default.
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeArgs(mode).length).toBeGreaterThan(0);
    }
  });

  it("keeps the documented bypass flag", () => {
    expect(permissionModeArgs("bypass")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("never emits the bypass flag for a non-bypass mode", () => {
    for (const mode of ["auto", "default"] as const) {
      expect(permissionModeArgs(mode).join(" ")).not.toContain("dangerously");
    }
  });
});

describe("parsePermissionMode", () => {
  it("accepts the canonical names", () => {
    expect(parsePermissionMode("auto")).toBe("auto");
    expect(parsePermissionMode("bypass")).toBe("bypass");
    expect(parsePermissionMode("default")).toBe("default");
  });

  it("accepts the aliases people actually type", () => {
    expect(parsePermissionMode("manual")).toBe("default");
    expect(parsePermissionMode("supervised")).toBe("default");
    expect(parsePermissionMode("ask")).toBe("default");
    expect(parsePermissionMode("skip")).toBe("bypass");
    expect(parsePermissionMode("bypassPermissions")).toBe("bypass");
  });

  it("is case- and whitespace-tolerant (phone keyboards capitalise)", () => {
    expect(parsePermissionMode("  Auto ")).toBe("auto");
    expect(parsePermissionMode("BYPASS")).toBe("bypass");
  });

  it("rejects anything else instead of guessing", () => {
    expect(parsePermissionMode("plan")).toBeNull();
    expect(parsePermissionMode("acceptEdits")).toBeNull();
    expect(parsePermissionMode("")).toBeNull();
  });

  it("round-trips every mode through its own callback_data", () => {
    // /permissions builds buttons as `permmode:${mode}`; index.ts parses them back.
    for (const mode of PERMISSION_MODES) {
      expect(parsePermissionMode(mode)).toBe(mode);
    }
  });
});

describe("labels", () => {
  it("gives every mode a label, short form and help line", () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeLabel(mode)).toBeTruthy();
      expect(permissionModeShort(mode)).toBeTruthy();
      expect(permissionModeHelp(mode)).toBeTruthy();
    }
  });

  it("says out loud that bypass has no protection", () => {
    expect(permissionModeHelp("bypass").toLowerCase()).toContain("injection");
  });

  it("offers auto first in the picker, bypass last", () => {
    expect(PERMISSION_MODES[0]).toBe("auto");
    expect(PERMISSION_MODES[PERMISSION_MODES.length - 1]).toBe("bypass");
  });
});
