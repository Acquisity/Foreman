export const REPLY_MARKER = "---reply---";

/**
 * The requester-facing part of a final assistant message. The model marks
 * where its narration ends and the reply begins with the marker on a line of
 * its own; everything before that line stays in the session. A marker
 * mentioned mid-line is prose, not a boundary. No marker means the whole message is the
 * reply, so an unmarked message posts exactly as it did before.
 */
export const replyOf = (message: string): string => {
  const lines = message.split("\n");
  const at = lines.findIndex((line) => line.trim() === REPLY_MARKER);
  return (at === -1 ? message : lines.slice(at + 1).join("\n")).trim();
};
