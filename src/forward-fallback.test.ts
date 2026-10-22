import { describe, it, expect, vi } from "vitest";
import { forwardWithFallback } from "./forward-fallback.js";

const okResponse = { ok: true, status: 200, text: async () => "ok" } as unknown as Response;
const errResponse = { ok: false, status: 500, text: async () => "boom" } as unknown as Response;

function run(
  fetchFn: (...a: unknown[]) => Promise<Response>,
  text = "the answer",
  sendDirect = vi.fn<(chunk: string) => Promise<unknown>>(async () => ({})),
) {
  return {
    sendDirect,
    outcome: forwardWithFallback({
      topicId: 1, port: 8801, token: "t", text, sendDirect,
      fetchFn: fetchFn as unknown as typeof fetch,
    }),
  };
}

describe("forwardWithFallback", () => {
  it("returns 'forwarded' and never sends directly when /forward succeeds", async () => {
    const { sendDirect, outcome } = run(vi.fn(async () => okResponse));
    await expect(outcome).resolves.toBe("forwarded");
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it("falls back to a direct send when /forward answers non-2xx", async () => {
    const { sendDirect, outcome } = run(vi.fn(async () => errResponse));
    await expect(outcome).resolves.toBe("direct");
    expect(sendDirect).toHaveBeenCalledWith("the answer");
  });

  it("falls back to a direct send when the fetch throws (network error / timeout)", async () => {
    const { sendDirect, outcome } = run(vi.fn(async () => { throw new Error("fetch failed"); }));
    await expect(outcome).resolves.toBe("direct");
    expect(sendDirect).toHaveBeenCalledWith("the answer");
  });

  it("splits an over-length text into multiple direct sends, none exceeding 4096", async () => {
    const long = ("A paragraph of Claude output.\n\n").repeat(400); // ~12k chars
    const { sendDirect, outcome } = run(vi.fn(async () => errResponse), long);
    await expect(outcome).resolves.toBe("direct");
    expect(sendDirect.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendDirect.mock.calls) {
      expect((call[0] as string).length).toBeLessThanOrEqual(4096);
    }
  });

  it("returns 'lost' when the direct send also fails", async () => {
    const failingSend = vi.fn(async () => { throw new Error("telegram down"); });
    const { outcome } = run(vi.fn(async () => errResponse), "the answer", failingSend);
    await expect(outcome).resolves.toBe("lost");
  });
});
