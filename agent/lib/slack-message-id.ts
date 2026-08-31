import { createHash } from "node:crypto";

/** Builds a stable UUID-shaped Slack `client_msg_id` from bounded identity parts. */
export const stableSlackClientMessageId = (
  ...parts: readonly string[]
): string => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part).update("\0");
  }
  const hex = hash.digest("hex");
  // Slack clients use UUID-shaped client_msg_id values. Fix the version and
  // variant nibbles while retaining the remaining deterministic hash payload.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
