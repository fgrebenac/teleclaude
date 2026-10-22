import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveWithinRoot, MAX_SEND_FILE_BYTES } from "./path-containment.js";

let root: string;
let outside: string;

beforeEach(() => {
  // realpathSync: on macOS /tmp is a symlink to /private/tmp — resolve now so
  // path-equality assertions compare like with like.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tc-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "tc-outside-")));
  writeFileSync(join(root, "report.pdf"), "ok");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "nested.txt"), "ok");
  writeFileSync(join(outside, "secret"), "id_rsa contents");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("accepts a file directly inside the root", () => {
    const res = resolveWithinRoot(root, join(root, "report.pdf"));
    expect(res).toEqual({ ok: true, path: join(root, "report.pdf"), bytes: 2 });
  });

  it("accepts a file in a subdirectory", () => {
    expect(resolveWithinRoot(root, join(root, "sub", "nested.txt")).ok).toBe(true);
  });

  it("resolves a relative path against the root", () => {
    const res = resolveWithinRoot(root, "sub/nested.txt");
    expect(res).toEqual({ ok: true, path: join(root, "sub", "nested.txt"), bytes: 2 });
  });

  it("rejects ../ traversal out of the root", () => {
    const res = resolveWithinRoot(root, join(root, "..", "..", "etc", "hosts"));
    expect(res.ok).toBe(false);
  });

  it("rejects an absolute path outside the root", () => {
    const res = resolveWithinRoot(root, join(outside, "secret"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("outside the project directory");
  });

  it("rejects a symlink inside the root pointing outside (the classic exfil trick)", () => {
    symlinkSync(join(outside, "secret"), join(root, "innocent.txt"));
    const res = resolveWithinRoot(root, join(root, "innocent.txt"));
    expect(res.ok).toBe(false);
  });

  it("accepts a symlink whose target is inside the root", () => {
    symlinkSync(join(root, "report.pdf"), join(root, "link.pdf"));
    const res = resolveWithinRoot(root, join(root, "link.pdf"));
    expect(res).toEqual({ ok: true, path: join(root, "report.pdf"), bytes: 2 });
  });

  it("rejects a directory", () => {
    const res = resolveWithinRoot(root, join(root, "sub"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not a regular file");
  });

  it("rejects a missing file with a readable reason, not a throw", () => {
    const res = resolveWithinRoot(root, join(root, "nope.txt"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not found");
  });

  it("rejects a file over the size cap", () => {
    const res = resolveWithinRoot(root, join(root, "report.pdf"), 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("send limit");
  });

  it("fails closed when no root is configured", () => {
    const res = resolveWithinRoot("", join(root, "report.pdf"));
    expect(res.ok).toBe(false);
  });

  it("does not treat a sibling dir with the root as a prefix as inside (rootX vs root)", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "f"), "x");
    try {
      expect(resolveWithinRoot(root, join(sibling, "f")).ok).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("exports a default cap of 50MB (Telegram's document upload limit)", () => {
    expect(MAX_SEND_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  // --- Adversarial regression guards ---
  // These already pass against the current implementation; they exist to
  // catch a future regression, not to change behavior.

  it("rejects a path containing a NUL byte", () => {
    const res = resolveWithinRoot(root, join(root, "ok\0/../../etc/passwd"));
    expect(res.ok).toBe(false);
  });

  it("rejects when an INTERMEDIATE directory is a symlink pointing outside the root", () => {
    // root/link -> outside/ (a whole directory, not just the leaf file), then
    // request a file *through* that symlinked directory. realpathSync must
    // resolve the intermediate component, not just the final segment.
    symlinkSync(outside, join(root, "link"));
    const res = resolveWithinRoot(root, join(root, "link", "secret"));
    expect(res.ok).toBe(false);
  });

  it("rejects a multi-hop symlink chain that ends outside the root", () => {
    // root/a -> root/b -> outside/secret
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(outside, "secret"), join(root, "b"));
    const res = resolveWithinRoot(root, join(root, "a"));
    expect(res.ok).toBe(false);
  });

  it("rejects the root directory itself as a target (not a regular file)", () => {
    const res = resolveWithinRoot(root, root);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not a regular file");
  });
});

import { isPathInside } from "./path-containment.js";

describe("isPathInside", () => {
  it("accepts the root itself", () => {
    expect(isPathInside(root, root)).toBe(true);
  });

  it("accepts a nested child", () => {
    expect(isPathInside(root, join(root, "sub", "nested.txt"))).toBe(true);
  });

  it("rejects a sibling with the root as a string prefix (rootX vs root)", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling);
    try {
      expect(isPathInside(root, sibling)).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects a path entirely outside the root", () => {
    expect(isPathInside(root, outside)).toBe(false);
  });

  it("degrades to string comparison when the child no longer exists on disk", () => {
    // Simulates a deleted worktree: the transcript recorded this cwd while the
    // directory existed, but by the time we check, it's gone. realpathSync
    // throws for a missing path — the child must fall back to the raw string,
    // which is still a valid containment test since Claude Code records
    // canonical absolute paths.
    const goneNested = join(root, "worktrees", "long-gone");
    expect(isPathInside(root, goneNested)).toBe(true);
  });

  it("degrades to string comparison for a gone child that is NOT actually nested", () => {
    const goneSibling = `${root}-web`;
    expect(isPathInside(root, goneSibling)).toBe(false);
  });

  it("uses the injected realpath function on both sides, not the real filesystem", () => {
    const fakeRealpath = (p: string) => (p === "/alias-root" ? "/actual/project" : p);
    // The raw strings share no prefix at all — this only passes if `root` was
    // actually run through fakeRealpath before the comparison.
    expect(isPathInside("/alias-root", "/actual/project/child", fakeRealpath)).toBe(true);
    expect(isPathInside("/alias-root", "/unrelated/child", fakeRealpath)).toBe(false);
  });
});
