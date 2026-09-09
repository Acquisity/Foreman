import { defineSchedule } from "eve/schedules";
import support from "../channels/support.js";
import { runSupportSchedule } from "../lib/support/dispatch.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      runSupportSchedule("intake", appAuth, (_claim, auth) =>
        to(support, {}).send(
          "Process the scheduled Intercom case bound to this session.",
          { auth }
        )
      )
    );
  },
});
