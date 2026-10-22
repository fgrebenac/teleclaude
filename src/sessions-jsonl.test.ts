import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { forEachJsonLine, forEachLine, JSONL_CHUNK_BYTES } from "./sessions.js";

const dirs: string[] = [];
function fixture(content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "teleclaude-jsonl-"));
  dirs.push(dir);
  const p = join(dir, "session.jsonl");
  writeFileSync(p, content);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("forEachLine", () => {
  it("yields each line without its terminator", () => {
    const lines: string[] = [];
    expect(forEachLine(fixture("a\nbb\nccc\n"), (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual(["a", "bb", "ccc"]);
  });

  it("yields the final line when the file has no trailing newline", () => {
    // A live session's transcript is often mid-write.
    const lines: string[] = [];
    forEachLine(fixture("one\ntwo"), (l) => lines.push(l));
    expect(lines).toEqual(["one", "two"]);
  });

  it("returns false for a missing file instead of throwing", () => {
    expect(forEachLine("/nonexistent/nope.jsonl", () => {})).toBe(false);
  });

  it("handles an empty file", () => {
    const lines: string[] = [];
    expect(forEachLine(fixture(""), (l) => lines.push(l))).toBe(true);
    expect(lines).toEqual([]);
  });

  it("does not corrupt multi-byte characters split across a chunk boundary", () => {
    // The reason this uses StringDecoder. Transcripts are full of non-ASCII —
    // "Crème", "Café", emoji — and a chunk can end mid-character.
    const line = "Crème brûlée — Café ✅ 🎉";
    const path = fixture(`${line}\n${line}\n`);
    for (const chunk of [1, 2, 3, 5, 7, 8, 13]) {
      const lines: string[] = [];
      forEachLine(path, (l) => lines.push(l), chunk);
      expect(lines, `chunk size ${chunk}`).toEqual([line, line]);
    }
  });

  it("reassembles a line that spans many chunks", () => {
    const long = "x".repeat(5000);
    const lines: string[] = [];
    forEachLine(fixture(`${long}\nshort\n`), (l) => lines.push(l), 64);
    expect(lines[0]).toBe(long);
    expect(lines[1]).toBe("short");
  });

  it("handles many lines inside a single chunk", () => {
    // Exercises the slice-once-per-chunk path.
    const count = 2000;
    const body = Array.from({ length: count }, (_, i) => `line${i}`).join("\n") + "\n";
    let seen = 0;
    let last = "";
    forEachLine(fixture(body), (l) => { seen++; last = l; });
    expect(seen).toBe(count);
    expect(last).toBe(`line${count - 1}`);
  });

  it("passes blank lines through — filtering is the JSON layer's job", () => {
    const lines: string[] = [];
    forEachLine(fixture("a\n\nb\n"), (l) => lines.push(l));
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("forEachJsonLine", () => {
  it("parses each entry", () => {
    const seen: unknown[] = [];
    const path = fixture('{"type":"user"}\n{"type":"assistant","n":2}\n');
    expect(forEachJsonLine(path, (e) => seen.push(e))).toBe(true);
    expect(seen).toEqual([{ type: "user" }, { type: "assistant", n: 2 }]);
  });

  it("skips blank lines and unparseable ones without aborting the walk", () => {
    // A transcript being appended to can end in a half-written line.
    const seen: unknown[] = [];
    forEachJsonLine(fixture('{"a":1}\n\nnot json\n{"b":2}\n{"c":'), (e) => seen.push(e));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns false for a missing file", () => {
    expect(forEachJsonLine("/nonexistent/nope.jsonl", () => {})).toBe(false);
  });

  it("survives a boundary split inside a JSON string value", () => {
    const path = fixture('{"text":"Crème ✅"}\n{"text":"Café"}\n');
    const seen: any[] = [];
    forEachJsonLine(path, (e) => seen.push(e), 4);
    expect(seen.map((e) => e.text)).toEqual(["Crème ✅", "Café"]);
  });

  it("uses a chunked default rather than reading whole files", () => {
    // The point of the change: peak memory is a chunk, not the file.
    expect(JSONL_CHUNK_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(JSONL_CHUNK_BYTES).toBeGreaterThan(1024);
  });
});
