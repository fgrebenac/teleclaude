import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface VersionInfo {
  version: string;
  commit: string;
  branch: string;
  dirty: boolean;
}

/** Project root — version.ts lives in src/, so one level up. */
function projectRoot(): string {
  return join(import.meta.dirname, "..");
}

/** Read the package.json version (the source of truth for releases). */
export function packageVersion(): string {
  // Stamped at bundle time by scripts/build.sh via esbuild --define (a string
  // literal in dist/*.js); a plain env var in dev, normally unset.
  if (process.env.TELECLAUDE_BUILD_VERSION) return process.env.TELECLAUDE_BUILD_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Full version info including git state. Git fields are best-effort. */
export function getVersion(): VersionInfo {
  const version = packageVersion();
  // A packaged install has no .git and possibly no git binary — the build
  // stamp is the truth there. Dev checkouts fall through to live git state.
  if (process.env.TELECLAUDE_BUILD_COMMIT) {
    return { version, commit: process.env.TELECLAUDE_BUILD_COMMIT, branch: "release", dirty: false };
  }
  const git = (args: string): string => {
    try {
      return execSync(`git ${args}`, { cwd: projectRoot(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  return {
    version,
    commit: git("rev-parse --short HEAD") || "unknown",
    branch: git("rev-parse --abbrev-ref HEAD") || "unknown",
    dirty: git("status --porcelain") !== "",
  };
}

/** One-line human-readable version string, e.g. "v1.1.0 (345d5e6 on main)". */
export function versionString(): string {
  const v = getVersion();
  const dirty = v.dirty ? "+dirty" : "";
  return `v${v.version} (${v.commit}${dirty} on ${v.branch})`;
}
