import type { WidgetContext } from "./widget-scope.js";

/**
 * The team's published schedule as a server-owned note for the front-door
 * writers, so a question about when a person is available, the hours or a
 * holiday gets the real answer, open or closed (ENG-15262). Null with office
 * hours off or absent, or with any part of the schedule missing, so those
 * prompts stay exactly as before.
 */
export const officeSchedule = (scope: WidgetContext): string | null => {
  const hours = scope.source === "widget" ? scope.officeHours : undefined;
  if (
    !(
      hours?.enabled &&
      hours.hoursText?.length &&
      hours.timeZoneName &&
      hours.upcomingClosures
    )
  ) {
    return null;
  }
  const closures = hours.upcomingClosures.map(
    ({ date, hours: times, label }) =>
      `${date}${label ? ` (${label})` : ""}: ${times}`
  );
  return [
    `The support team's hours, from the app, in ${hours.timeZoneName}: ${hours.hoursText.join("; ")}.`,
    closures.length
      ? `Closures in the next 90 days: ${closures.join("; ")}.`
      : "No closures are scheduled in the next 90 days.",
    `The team is ${hours.open ? "open" : "away"} right now. When the customer asks when the team or a person is available, the hours, or about holidays or closures, answer from these hours and closures and name the time zone. They are the team's published schedule, not a promise of a reply, so stating them is allowed. Say only what they say, and mention a closure only when it is relevant.`,
  ].join(" ");
};
