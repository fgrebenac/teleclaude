import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot } from "grammy";
import { showTurnWarning, clearTurnWarning } from "./turn-warnings.js";

const CHAT = -100123;
const TOPIC = 42;

function makeBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Bot;
}

describe("turn-warnings", () => {
  beforeEach(() => { clearTurnWarning(CHAT, TOPIC); });

  it("sends a new message for the first warning", async () => {
    const bot = makeBot();
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working");
    expect(bot.api.sendMessage).toHaveBeenCalledWith(CHAT, "still working", expect.objectContaining({ message_thread_id: TOPIC }));
  });

  it("upgrades an existing soft message in place on a hard alert, instead of sending a new one", async () => {
    const bot = makeBot();
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working");
    await showTurnWarning(bot, CHAT, TOPIC, "hard", "stuck", [[{ text: "Force Stop", callback_data: "x" }]]);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageText).toHaveBeenCalledWith(CHAT, 555, "stuck", expect.objectContaining({
      reply_markup: { inline_keyboard: [[{ text: "Force Stop", callback_data: "x" }]] },
    }));
  });

  it("drops a soft warning once a hard alert is already showing (monotonic severity)", async () => {
    const bot = makeBot();
    await showTurnWarning(bot, CHAT, TOPIC, "hard", "stuck", [[{ text: "Force Stop", callback_data: "x" }]]);
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  it("clearTurnWarning forgets the tracked message so the next warning starts fresh", async () => {
    const bot = makeBot();
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working");
    clearTurnWarning(CHAT, TOPIC);
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working again");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("falls through to a fresh send in the same call when the edit fails — a one-shot hard alert is never swallowed", async () => {
    const bot = makeBot();
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working");
    (bot.api.editMessageText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("message to edit not found"));
    await showTurnWarning(bot, CHAT, TOPIC, "hard", "stuck", [[{ text: "Force Stop", callback_data: "x" }]]);
    // The hard alert reached the user NOW, buttons included — not on some future call.
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(bot.api.sendMessage).toHaveBeenLastCalledWith(CHAT, "stuck", expect.objectContaining({
      message_thread_id: TOPIC,
      reply_markup: { inline_keyboard: [[{ text: "Force Stop", callback_data: "x" }]] },
    }));
    // And the fresh message is tracked: severity stays monotonic afterwards.
    await showTurnWarning(bot, CHAT, TOPIC, "soft", "still working again");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
