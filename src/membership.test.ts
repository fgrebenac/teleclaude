import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isChatMember, filterByMembership, clearMembershipCache } from "./membership.js";

function fakeApi(statuses: Record<string, string>, calls: string[] = []) {
  return {
    getChatMember: async (chatId: number, userId: number) => {
      calls.push(`${chatId}:${userId}`);
      const s = statuses[`${chatId}:${userId}`];
      if (!s) throw new Error("Bad Request: user not found");
      return { status: s };
    },
  };
}

describe("isChatMember", () => {
  beforeEach(() => { clearMembershipCache(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("member/admin/creator pass, left/kicked and errors fail", async () => {
    const api = fakeApi({ "1:9": "member", "2:9": "left", "3:9": "administrator" });
    expect(await isChatMember(api, 1, 9)).toBe(true);
    expect(await isChatMember(api, 2, 9)).toBe(false);
    expect(await isChatMember(api, 3, 9)).toBe(true);
    expect(await isChatMember(api, 4, 9)).toBe(false); // throws inside → false
  });

  it("caches per (chat,user) for 5 minutes", async () => {
    const calls: string[] = [];
    const api = fakeApi({ "1:9": "member" }, calls);
    await isChatMember(api, 1, 9);
    await isChatMember(api, 1, 9);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await isChatMember(api, 1, 9);
    expect(calls).toHaveLength(2);
  });
});

describe("filterByMembership", () => {
  beforeEach(() => clearMembershipCache());

  it("drops projects in foreign groups, keeps chatId-less ones", async () => {
    const api = fakeApi({ "1:9": "member" });
    const items = [
      { name: "mine", chatId: 1 },
      { name: "theirs", chatId: 2 },
      { name: "legacy" }, // no chatId — resolves to "no-chat" downstream
    ];
    const out = await filterByMembership(api, items, 9);
    expect(out.map((i) => i.name)).toEqual(["mine", "legacy"]);
  });
});
