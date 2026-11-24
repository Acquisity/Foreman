import type { WidgetContext } from "./widget-scope.js";

const localTime = (now: Date, timeZone: string): string | null => {
  try {
    const zoneName = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    const when = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(now);
    return `${when} ${zoneName ?? timeZone}`;
  } catch {
    return null;
  }
};

/**
 * When the customer asked, in their own time zone, so the investigator and the
 * composer call a date today, tomorrow or past against the customer's
 * calendar, not the model's guess (ENG-20503). A live re-run keeps the
 * recorded question's time and zone.
 */
export const askedAtLine = (
  scope: WidgetContext,
  clock = new Date()
): string => {
  const now = scope.liveAsOf ? new Date(scope.liveAsOf) : clock;
  const customerZone =
    scope.source === "widget" || scope.liveAsOf
      ? scope.officeHours?.customerTimeZone
      : undefined;
  const local = customerZone ? localTime(now, customerZone) : null;
  if (local) {
    return `ASKED AT: ${local} in the customer's time zone (${customerZone}), ${now.toISOString()}. Call a date today, tomorrow, yesterday or already passed only by converting it to that time zone and comparing it with this date.`;
  }
  return `ASKED AT: ${now.toISOString()} (UTC). The customer's time zone is unknown, so give each date as a date, never as today, tomorrow or yesterday.`;
};
