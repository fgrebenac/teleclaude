/**
 * Callback-data contract for the "🖼 Preview as images" button on a /diff
 * report. No chatId/topicId is encoded in the payload — the callback handler
 * (src/handlers/index.ts) derives both from ctx.callbackQuery.message, the
 * same pattern src/handlers/schedule.ts's handleDigestCallback already uses.
 * Kept in its own module so the literal exists exactly once and is trivially
 * testable without grammy.
 */
export const DIFF_IMAGE_CALLBACK_DATA = "diffimg";

export function isDiffImageCallback(data: string): boolean {
  return data === DIFF_IMAGE_CALLBACK_DATA;
}
