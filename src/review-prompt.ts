/**
 * /review turn-end prompt: when a topic has review-on-done enabled and the
 * project's tree finished a turn with uncommitted changes, offer the user a
 * quick look before more work piles up. The decision is a pure function so the
 * (untestable) done-hook closure stays thin; the callback-data parse is shared
 * by the button handler.
 */

/** Fire the prompt only when the user asked for it AND there's something to see. */
export function shouldPromptReview(reviewOn: boolean, hasChanges: boolean): boolean {
  return reviewOn && hasChanges;
}

export type ReviewVerb = "diff" | "commit" | "leave";
export type ReviewAction = { verb: ReviewVerb; chatId: number; topicId: number };

/** Parse a `review:<verb>:<chatId>:<topicId>` callback payload; null if it isn't one. */
export function parseReviewAction(data: string): ReviewAction | null {
  const m = /^review:(diff|commit|leave):(-?\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return { verb: m[1] as ReviewVerb, chatId: Number(m[2]), topicId: Number(m[3]) };
}

/** Build the callback payload for a review button. */
export function reviewCallbackData(verb: ReviewVerb, chatId: number, topicId: number): string {
  return `review:${verb}:${chatId}:${topicId}`;
}
