import { describe, expect, it } from "vitest";
import { activityRenderDelayMs } from "./activity-render.js";

const FIRST = 150;
const COALESCE = 1000;

describe("activityRenderDelayMs", () => {
  it("skips (null) once the turn has collapsed to its summary, whatever the message state", () => {
    expect(activityRenderDelayMs(true, false, FIRST, COALESCE)).toBeNull();
    expect(activityRenderDelayMs(true, true, FIRST, COALESCE)).toBeNull();
  });

  it("uses the short first-render delay when no message exists yet (turn opening)", () => {
    expect(activityRenderDelayMs(false, false, FIRST, COALESCE)).toBe(FIRST);
  });

  it("uses the normal coalesce delay once the turn's message exists", () => {
    expect(activityRenderDelayMs(false, true, FIRST, COALESCE)).toBe(COALESCE);
  });

  it("the first-render delay is shorter than the coalesce delay (the whole point)", () => {
    const opening = activityRenderDelayMs(false, false, FIRST, COALESCE)!;
    const later = activityRenderDelayMs(false, true, FIRST, COALESCE)!;
    expect(opening).toBeLessThan(later);
  });
});
