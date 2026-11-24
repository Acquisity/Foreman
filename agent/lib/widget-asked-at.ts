import type { WidgetContext } from "./widget-scope.js";

const localTime = (now: Date, timeZone: string): string | null => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    })
      .format(now)
      .concat(
        " ",
        new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
          .formatToParts(now)
          .find((part) => part.type === "timeZoneName")?.value ?? ""
      );
  } catch {
    return null;
  }
};

/**
 * When the customer asked, in their own time zone, so the investigator and the
 * composer call a date today, tomorrow or past against the customer's
 * calendar, not the model's guess (ENG-20503).
 */
export const askedAtLine = (scope: WidgetContext, now = new Date()): string => {
  const customerZone =
    scope.source === "widget" ? scope.officeHours?.customerTimeZone : undefined;
  const local = customerZone ? localTime(now, customerZone) : null;
  const [when, zone] = local
    ? [local, customerZone]
    : [localTime(now, "UTC"), "UTC"];
  return `ASKED AT: ${when} in the customer's time zone (${zone}), ${now.toISOString()}. Call a date today, tomorrow, yesterday or already passed only by converting it to that time zone and comparing it with this date.`;
};
