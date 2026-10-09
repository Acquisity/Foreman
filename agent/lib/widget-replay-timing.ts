/** First customer answer, measured at the replay poll resolution. Progress is not a reply. */
export const replyElapsed = (
  response: { message?: unknown },
  sentAt: number,
  observedAt: number
) =>
  typeof response.message === "string" && response.message.trim()
    ? observedAt - sentAt
    : null;
