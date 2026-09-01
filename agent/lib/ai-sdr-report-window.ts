/**
 * Window arithmetic for the weekly AI SDR performance report.
 *
 * @remarks
 * The report ships every Monday and covers the Monday to Friday that just
 * ended. Each metric is compared against the week before that and against the
 * same Monday to Friday four weeks earlier, which the report calls "same week
 * last month". Windows are day-aligned in UTC so the date strings line up with
 * `outreach_campaign_metrics.date` (a bare `YYYY-MM-DD` text column).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of the calendar day containing `ms`. */
const utcMidnight = (ms: number): number =>
  Date.UTC(
    new Date(ms).getUTCFullYear(),
    new Date(ms).getUTCMonth(),
    new Date(ms).getUTCDate()
  );

/** `YYYY-MM-DD` for a millisecond timestamp. */
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Most recent Friday strictly before `now`, as UTC-midnight milliseconds.
 *
 * @remarks
 * `getUTCDay()` is 0 for Sunday through 6 for Saturday. Friday is 5. A Friday
 * itself counts as zero days back, so the strictly-before adjustment pushes it
 * a full week, keeping the "previous Monday to Friday" window in the past even
 * when the schedule fires moments after midnight on a Friday.
 */
export const mostRecentFridayBefore = (now: Date): number => {
  const day = utcMidnight(now.getTime());
  const dow = now.getUTCDay();
  const daysSinceFriday = (dow - 5 + 7) % 7 === 0 ? 7 : (dow - 5 + 7) % 7;
  return day - daysSinceFriday * DAY_MS;
};

/** An inclusive report window plus its exclusive end, all as `YYYY-MM-DD`. */
export interface ReportWindow {
  end: string;
  /** Day after `end`, for `created_at < endExclusive` style bounds. */
  endExclusive: string;
  start: string;
}

/** The three windows a Monday report compares: report, prior week, prior month. */
export interface AiSdrReportWindows {
  previous: ReportWindow;
  report: ReportWindow;
  sameWeekLastMonth: ReportWindow;
}

const windowAround = (endMs: number): ReportWindow => {
  const startMs = endMs - 4 * DAY_MS; // Monday of that Mon-Fri week.
  const endExclusiveMs = endMs + DAY_MS;
  return {
    end: isoDate(endMs),
    endExclusive: isoDate(endExclusiveMs),
    start: isoDate(startMs),
  };
};

/**
 * Report windows for a dispatch at `now`.
 *
 * The report week is the Monday to Friday that most recently completed. The
 * previous week starts seven days earlier, and the "same week last month"
 * comparison starts 28 days earlier.
 */
export const aiSdrReportWindows = (now: Date): AiSdrReportWindows => {
  const friday = mostRecentFridayBefore(now);
  return {
    previous: windowAround(friday - 7 * DAY_MS),
    report: windowAround(friday),
    sameWeekLastMonth: windowAround(friday - 28 * DAY_MS),
  };
};
