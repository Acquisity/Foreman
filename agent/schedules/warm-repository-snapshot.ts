import { defineSchedule } from "eve/schedules";
import { createWarmSnapshot } from "../lib/repository-snapshot.js";

/**
 * Recreates the warm repository snapshot daily. The produced id is logged for
 * now; a follow-up promotes it into `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` (via the
 * Vercel API or a CI step) and triggers a redeploy so `agent/sandbox.ts` picks
 * up the rebuilt snapshot at the next template build.
 */
export default defineSchedule({
  cron: "0 0 * * *",
  run({ waitUntil }) {
    waitUntil(
      createWarmSnapshot()
        .then((id) => {
          console.log("Warm snapshot id:", id);
        })
        .catch((error) => {
          console.error("Warm snapshot creation failed:", error);
        })
    );
  },
});
