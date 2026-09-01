/**
 * Slack rejects a `markdown_text` field over 12,000 characters, and eve
 * swallows an event-handler throw, so one oversized or rejected post used
 * to cost the whole final reply. `splitSlackReply` keeps every post inside
 * the limit and `postSlackReply` turns a rejection into one short visible
 * fallback instead of silence.
 */
export const SLACK_MARKDOWN_MAX_LENGTH = 12_000;

/**
 * Splits a final reply into ordered chunks of at most `limit` characters.
 * Each cut takes the last paragraph boundary inside the window, then the
 * last line boundary, and hard-cuts at the limit only when the window has
 * neither. The boundary newline stays at the end of the earlier chunk, so
 * joining the chunks reproduces the input exactly. A hard cut that would
 * split a UTF-16 surrogate pair backs off one code unit, because the two
 * halves post as separate requests and each lone surrogate would arrive as
 * U+FFFD. Empty input yields no chunks.
 */
export const splitSlackReply = (
  text: string,
  limit = SLACK_MARKDOWN_MAX_LENGTH
): string[] => {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new RangeError("limit must be an integer of at least 2");
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    let cut = limit;
    if (paragraph > 0) {
      cut = paragraph + 2;
    } else if (line > 0) {
      cut = line + 1;
    } else if (cut > 1 && isSurrogatePairAt(rest, cut)) {
      cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
};

const isHighSurrogate = (code: number) => code >= 0xd8_00 && code <= 0xdb_ff;

const isLowSurrogate = (code: number) => code >= 0xdc_00 && code <= 0xdf_ff;

const isSurrogatePairAt = (text: string, cut: number) =>
  isHighSurrogate(text.charCodeAt(cut - 1)) &&
  isLowSurrogate(text.charCodeAt(cut));

// The code capture is bounded so an arbitrarily long code-shaped message
// falls through to the generic line instead of overflowing the fallback
// past the same 12,000-character limit this module exists to respect.
const SLACK_POST_ERROR =
  /^Slack chat\.postMessage (?:failed: ([a-z0-9_]{1,80})|returned HTTP (\d{3}))$/;

/**
 * Names the Slack error only when the failure is eve's SlackApiError from
 * the post itself, whose message carries the API error code or HTTP status.
 * Anything else (broker, configuration, network) is not a Slack rejection
 * and its message can carry internals, so the visible fallback stays
 * generic while the full error remains in the log.
 */
const describeSlackError = (error: unknown): string | null => {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = SLACK_POST_ERROR.exec(error.message.trim());
  const code = match?.[1];
  const status = match?.[2];
  if (code !== undefined) {
    return `Slack said ${code}`;
  }
  return status === undefined ? null : `Slack returned HTTP ${status}`;
};

const fallbackLine = (error: unknown): string => {
  const detail = describeSlackError(error);
  return detail === null
    ? "I finished the work, but the reply could not be posted. Ask me to resend."
    : `I finished the work, but Slack rejected the reply (${detail}). Ask me to resend.`;
};

/**
 * Posts a final reply through `post` as ordered chunks. When a post throws,
 * the original failure is logged and exactly one short fallback is
 * attempted. A failing fallback is only logged: eve swallows event-handler
 * throws, so rethrowing would surface nothing.
 */
export const postSlackReply = async (
  post: (text: string) => Promise<unknown>,
  text: string
): Promise<void> => {
  try {
    for (const chunk of splitSlackReply(text)) {
      // biome-ignore lint/performance/noAwaitInLoops: chunks must post sequentially so the reply arrives in order.
      await post(chunk);
    }
  } catch (error) {
    console.error("Slack reply post failed.", error);
    try {
      await post(fallbackLine(error));
    } catch (fallbackError) {
      console.error("Slack reply fallback post failed.", fallbackError);
    }
  }
};
