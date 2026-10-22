import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postToTopic, parseChannelResponseFlags } from "./channel-post.js";

function target(port?: number, token?: string) {
  return {
    getPort: () => port,
    getSpawnToken: () => token,
  };
}

describe("postToTopic", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the JSON body to the topic's port + path with the auth header", async () => {
    const res = await postToTopic(target(8805, "tok-abc"), -100, 42, "/tool", { tool_name: "Bash" });
    expect(res?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8805/tool");
    expect(init.method).toBe("POST");
    expect(init.headers["x-teleclaude-token"]).toBe("tok-abc");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ tool_name: "Bash" });
  });

  it("returns null without fetching when the topic has no live port", async () => {
    expect(await postToTopic(target(undefined, "tok"), -100, 42, "", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never omits the auth header — a missing token becomes the empty string", async () => {
    await postToTopic(target(8805, undefined), -100, 42, "", {});
    expect(fetchMock.mock.calls[0][1].headers["x-teleclaude-token"]).toBe("");
  });

  it("attaches an abort signal only when timeoutMs is given", async () => {
    await postToTopic(target(8805, "t"), -100, 42, "/forward", { text: "x" }, { timeoutMs: 30_000 });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await postToTopic(target(8805, "t"), -100, 42, "/done", {});
    expect(fetchMock.mock.calls[1][1].signal).toBeUndefined();
  });

  it("propagates network errors to the caller (fire-and-forget sites attach .catch)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(postToTopic(target(8805, "t"), -100, 42, "", {})).rejects.toThrow("ECONNREFUSED");
  });
});

describe("parseChannelResponseFlags", () => {
  it("parses duplicate", () => {
    expect(parseChannelResponseFlags('{"duplicate":true}')).toEqual({ consumed: false, duplicate: true });
  });
  it("parses consumed", () => {
    expect(parseChannelResponseFlags('{"consumed":true}')).toEqual({ consumed: true, duplicate: false });
  });
  it("treats plain ok and garbage as neither", () => {
    expect(parseChannelResponseFlags("ok")).toEqual({ consumed: false, duplicate: false });
    expect(parseChannelResponseFlags("")).toEqual({ consumed: false, duplicate: false });
  });
});
