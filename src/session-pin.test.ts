import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSessionState, updateTopicSession, getTopicSession } from "./session-state.js";
import { maintainSessionPin, removeSessionPin, pinText, resetPinNoticeMemory } from "./session-pin.js";

const CHAT = -100123;
const TOPIC = 42;

function makeApi() {
  let nextId = 100;
  return {
    sendMessage: vi.fn(async (_chat: number, _text: string, _other?: object) => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async (_chat: number, _msg: number, _text: string): Promise<unknown> => true),
    pinChatMessage: vi.fn(async (_chat: number, _msg: number, _other?: object): Promise<unknown> => true),
    unpinChatMessage: vi.fn(async (_chat: number, _msg?: number): Promise<unknown> => true),
    deleteMessage: vi.fn(async (_chat: number, _msg: number): Promise<unknown> => true),
  };
}

beforeEach(() => {
  loadSessionState(mkdtempSync(join(tmpdir(), "pin-test-")));
  resetPinNoticeMemory();
});

describe("pinText", () => {
  it("includes the model when known", () => {
    expect(pinText("todo-c6", "opus")).toBe("📌 todo-c6 · opus");
  });
  it("is just the name without one", () => {
    expect(pinText("todo-c6")).toBe("📌 todo-c6");
  });
});

describe("maintainSessionPin", () => {
  it("creates, pins and persists the message on first run", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "my-task", model: "opus" });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC);

    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith(CHAT, "📌 my-task · opus", {
      message_thread_id: TOPIC,
      disable_notification: true,
    });
    expect(api.pinChatMessage).toHaveBeenCalledExactlyOnceWith(CHAT, 100, { disable_notification: true });
    const saved = getTopicSession(CHAT, TOPIC);
    expect(saved?.pinnedMessageId).toBe(100);
    expect(saved?.pinnedText).toBe("📌 my-task · opus");
  });

  it("does nothing when the toggle is off", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "my-task", pinSession: false });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("does nothing when no name is known", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p" });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("skips every API call when the pin already shows this text", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "my-task" });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC);
    await maintainSessionPin(api, CHAT, TOPIC);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("edits in place on a name change — never re-pins", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "old-name" });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC);
    updateTopicSession(CHAT, TOPIC, { name: "new-name" });
    await maintainSessionPin(api, CHAT, TOPIC);

    expect(api.editMessageText).toHaveBeenCalledExactlyOnceWith(CHAT, 100, "📌 new-name");
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.pinChatMessage).toHaveBeenCalledTimes(1);
    expect(getTopicSession(CHAT, TOPIC)?.pinnedText).toBe("📌 new-name");
  });

  it("prefers the live registry name over the persisted one", async () => {
    const registryDir = mkdtempSync(join(tmpdir(), "pin-registry-"));
    writeFileSync(join(registryDir, "123.json"), JSON.stringify({ pid: 123, name: "derived-c6" }));
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "stale-name" });
    const api = makeApi();
    await maintainSessionPin(api, CHAT, TOPIC, { pid: 123, registryBaseDir: registryDir });
    expect(api.sendMessage).toHaveBeenCalledWith(CHAT, "📌 derived-c6", expect.anything());
  });

  it("recreates the pin when the message was deleted by hand", async () => {
    updateTopicSession(CHAT, TOPIC, {
      sessionId: "s1", projectPath: "/p", name: "my-task",
      pinnedMessageId: 55, pinnedText: "📌 old",
    });
    const api = makeApi();
    api.editMessageText.mockRejectedValue({ description: "Bad Request: message to edit not found" });
    await maintainSessionPin(api, CHAT, TOPIC);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.pinChatMessage).toHaveBeenCalledTimes(1);
    expect(getTopicSession(CHAT, TOPIC)?.pinnedMessageId).toBe(100);
  });

  it("treats 'message is not modified' as success", async () => {
    updateTopicSession(CHAT, TOPIC, {
      sessionId: "s1", projectPath: "/p", name: "my-task",
      pinnedMessageId: 55, pinnedText: "📌 stale-memory",
    });
    const api = makeApi();
    api.editMessageText.mockRejectedValue({ description: "Bad Request: message is not modified" });
    await maintainSessionPin(api, CHAT, TOPIC);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(getTopicSession(CHAT, TOPIC)?.pinnedText).toBe("📌 my-task");
    expect(getTopicSession(CHAT, TOPIC)?.pinnedMessageId).toBe(55);
  });

  it("does NOT recreate on a transient edit failure — that would double-pin", async () => {
    updateTopicSession(CHAT, TOPIC, {
      sessionId: "s1", projectPath: "/p", name: "my-task",
      pinnedMessageId: 55, pinnedText: "📌 old",
    });
    const api = makeApi();
    api.editMessageText.mockRejectedValue(new Error("network timeout"));
    await maintainSessionPin(api, CHAT, TOPIC);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(getTopicSession(CHAT, TOPIC)?.pinnedMessageId).toBe(55);
  });

  it("on a pin-rights failure deletes the carrier and notifies once per topic", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p", name: "my-task" });
    const api = makeApi();
    api.pinChatMessage.mockRejectedValue({ description: "Bad Request: not enough rights to manage pinned messages" });

    await maintainSessionPin(api, CHAT, TOPIC);
    // carrier message + one warning notice
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 100);
    expect(getTopicSession(CHAT, TOPIC)?.pinnedMessageId).toBeUndefined();

    await maintainSessionPin(api, CHAT, TOPIC);
    // second round: carrier again, but no second notice
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("removeSessionPin", () => {
  it("unpins, deletes and forgets the tracked message", async () => {
    updateTopicSession(CHAT, TOPIC, {
      sessionId: "s1", projectPath: "/p", name: "my-task",
      pinnedMessageId: 55, pinnedText: "📌 my-task",
    });
    const api = makeApi();
    await removeSessionPin(api, CHAT, TOPIC);

    expect(api.unpinChatMessage).toHaveBeenCalledWith(CHAT, 55);
    expect(api.deleteMessage).toHaveBeenCalledWith(CHAT, 55);
    const saved = getTopicSession(CHAT, TOPIC);
    expect(saved?.pinnedMessageId).toBeUndefined();
    expect(saved?.pinnedText).toBeUndefined();
  });

  it("is a no-op with nothing tracked", async () => {
    updateTopicSession(CHAT, TOPIC, { sessionId: "s1", projectPath: "/p" });
    const api = makeApi();
    await removeSessionPin(api, CHAT, TOPIC);
    expect(api.unpinChatMessage).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });
});
