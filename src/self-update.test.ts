import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeRestartMarker, consumeRestartMarker } from "./self-update.js";

describe("restart marker", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "teleclaude-marker-"));
  });

  it("round-trips a marker and deletes it on consume", () => {
    writeRestartMarker({ chatId: 42, note: "after update", at: Date.now() }, dir);
    const marker = consumeRestartMarker(dir);
    expect(marker?.chatId).toBe(42);
    expect(marker?.note).toBe("after update");
    // consumed — second read finds nothing
    expect(consumeRestartMarker(dir)).toBeNull();
    expect(existsSync(join(dir, "restart-notify.json"))).toBe(false);
  });

  it("returns null when no marker exists", () => {
    expect(consumeRestartMarker(dir)).toBeNull();
  });

  it("discards a stale marker (older than 15 min) but still deletes it", () => {
    writeRestartMarker({ chatId: 42, note: "old", at: Date.now() - 16 * 60_000 }, dir);
    expect(consumeRestartMarker(dir)).toBeNull();
    expect(existsSync(join(dir, "restart-notify.json"))).toBe(false);
  });

  it("preserves the topicId when set", () => {
    writeRestartMarker({ chatId: 1, topicId: 77, note: "x", at: Date.now() }, dir);
    expect(consumeRestartMarker(dir)?.topicId).toBe(77);
  });
});
