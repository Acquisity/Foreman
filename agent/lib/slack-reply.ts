export const REPLY_MARKER = "---reply---";

/**
 * The requester-facing part of a final assistant message. The model marks
 * where its narration ends and the reply begins; everything before the
 * marker stays in the session. No marker means the whole message is the
 * reply, so an unmarked message posts exactly as it did before.
 */
export const replyOf = (message: string): string => {
  const at = message.indexOf(REPLY_MARKER);
  return (at === -1 ? message : message.slice(at + REPLY_MARKER.length)).trim();
};
