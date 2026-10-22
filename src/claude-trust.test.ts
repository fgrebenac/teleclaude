import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { preTrustWorkspace } from "./claude-trust.js";

describe("preTrustWorkspace", () => {
  let dir: string;
  let claudeJsonPath: string;
  // The real, symlink-resolved path — this is the key preTrustWorkspace
  // actually writes under (macOS's tmpdir() is itself a symlink), so tests
  // must key off the same resolved path or a mismatch looks like a bug.
  let projectDir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "teleclaude-trust-")));
    claudeJsonPath = join(dir, ".claude.json");
    projectDir = join(dir, "project");
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("does nothing when the global config doesn't exist yet", () => {
    expect(() => preTrustWorkspace(projectDir, claudeJsonPath)).not.toThrow();
  });

  it("sets hasTrustDialogAccepted for the project's real path, preserving unrelated projects", () => {
    writeFileSync(claudeJsonPath, JSON.stringify({
      projects: {
        "/some/other/project": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }));

    preTrustWorkspace(projectDir, claudeJsonPath);

    const result = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    expect(result.projects[projectDir]).toEqual({ hasTrustDialogAccepted: true });
    expect(result.projects["/some/other/project"]).toEqual({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
  });

  it("preserves other existing fields on the same project entry", () => {
    writeFileSync(claudeJsonPath, JSON.stringify({
      projects: {
        [projectDir]: { hasCompletedProjectOnboarding: true, allowedTools: ["Bash"] },
      },
    }));

    preTrustWorkspace(projectDir, claudeJsonPath);

    const result = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    expect(result.projects[projectDir]).toEqual({
      hasCompletedProjectOnboarding: true,
      allowedTools: ["Bash"],
      hasTrustDialogAccepted: true,
    });
  });

  it("is a no-op if the project is already trusted (no unnecessary rewrite)", () => {
    writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }));
    const before = readFileSync(claudeJsonPath, "utf-8");

    preTrustWorkspace(projectDir, claudeJsonPath);

    expect(readFileSync(claudeJsonPath, "utf-8")).toBe(before);
  });

  it("creates the projects object if the config file has none yet", () => {
    writeFileSync(claudeJsonPath, JSON.stringify({ tipsHistory: {} }));

    preTrustWorkspace(projectDir, claudeJsonPath);

    const result = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    expect(result.projects[projectDir]).toEqual({ hasTrustDialogAccepted: true });
    expect(result.tipsHistory).toEqual({});
  });

  it("never throws even if the config file is corrupt JSON", () => {
    writeFileSync(claudeJsonPath, "{not valid json");
    expect(() => preTrustWorkspace(projectDir, claudeJsonPath)).not.toThrow();
  });
});
