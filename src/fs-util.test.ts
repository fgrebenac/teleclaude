import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeJsonAtomic, readJsonTolerant } from "./fs-util.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tc-fsutil-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("writeJsonAtomic", () => {
  it("writes parseable JSON", () => {
    const file = join(dir, "state.json");
    writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ a: 1 });
  });

  it("writes files as 0600 — state holds session ids and chat ids", () => {
    const file = join(dir, "state.json");
    writeJsonAtomic(file, { a: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing world-readable file on rewrite (rename carries the temp mode)", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    writeJsonAtomic(file, { a: 2 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no .tmp file behind", () => {
    const file = join(dir, "state.json");
    writeJsonAtomic(file, { a: 1 });
    expect(() => statSync(`${file}.tmp`)).toThrow();
  });
});

describe("readJsonTolerant", () => {
  it("parses a valid file", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, '{"a":1}');
    expect(readJsonTolerant(file, "test")).toEqual({ a: 1 });
  });

  it("preserves a corrupt file as .corrupt-<ts> and returns undefined", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ torn writ");
    expect(readJsonTolerant(file, "test")).toBeUndefined();
    const backups = readdirSync(dir).filter((f) => f.startsWith("bad.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), "utf-8")).toBe("{ torn writ");
    // The original path is gone — the next save can't overwrite the evidence.
    expect(() => statSync(file)).toThrow();
  });

  it("returns undefined for a missing file without inventing a backup", () => {
    expect(readJsonTolerant(join(dir, "nope.json"), "test")).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes("corrupt"))).toHaveLength(0);
  });
});
