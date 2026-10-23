import { defineSchedule } from "eve/schedules";
import { runScheduledReporterUpdates } from "../lib/reporter-updates/schedule.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ waitUntil }) {
    waitUntil(
      runScheduledReporterUpdates().catch(() => {
        console.error("Reporter updates run failed.");
      })
    );
  },
});
