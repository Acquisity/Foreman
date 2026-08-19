/**
 * Window arithmetic for the daily SLA report.
 *
 * @remarks
 * The schedule reports on everything whose SLA clock started since the last
 * dispatch, so a missed or delayed tick is caught up rather than dropped. The
 * marker stores its own ISO timestamp as content: `uploadedAt` from Blob is
 * derived from the `last-modified` response header and silently falls back to
 * the current time when that header is absent, which would collapse the window
 * to zero and make every feature report nothing.
 */

/** Window used when no marker exists yet, so a first run cannot dump a backlog. */
export const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Oldest window a stored marker can open, so a long outage cannot replay everything. */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Start of the window a dispatch should report on.
 *
 * @param markerContents - Contents of the last-run marker, or null when it is
 * missing or unreadable. Unparseable contents are treated as missing.
 * @param now - Current time in milliseconds.
 */
export const slaWindowStart = (
  markerContents: string | null,
  now: number
): string => {
  const previous = markerContents
    ? Date.parse(markerContents.trim())
    : Number.NaN;
  if (Number.isNaN(previous)) {
    return new Date(now - FIRST_RUN_WINDOW_MS).toISOString();
  }
  return new Date(Math.max(previous, now - MAX_WINDOW_MS)).toISOString();
};
