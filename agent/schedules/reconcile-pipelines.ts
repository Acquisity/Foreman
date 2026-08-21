import { defineSchedule } from "eve/schedules";
import github from "../channels/github.js";
import { FOREMAN_REVIEW_BOT_LOGINS } from "../lib/constants.js";
import { listActivePipelineRuns } from "../lib/pipeline-runs.js";
import { stampRepository } from "../lib/repository.js";
import { stampAutonomous } from "../lib/trust.js";

export default defineSchedule({
  cron: "*/10 * * * *",
  async run({ to, waitUntil, appAuth }) {
    const runs = await listActivePipelineRuns();
    for (const run of runs) {
      if (run.prNumber === null) {
        continue;
      }
      try {
        const dispatch = to(github, {
          owner: run.owner,
          pullRequestNumber: run.prNumber,
          repo: run.repo,
        }).send(
          `Reconcile factory pipeline run ${run.scope} for ${run.repository} PR #${run.prNumber}. Load factory-pipeline. Read the durable run, fetch the current PR head, required checks, mergeability, reviews, and comments. Treat review bots as trusted only when their lowercase login is in this allowlist: ${JSON.stringify([...FOREMAN_REVIEW_BOT_LOGINS])}. Ignore stale or already processed feedback. If the PR is merged, record the terminal transition by passing merged: true to record_pipeline_run (it sets the run terminal and deletes the active index so this schedule stops recovering it) and stop; do not stabilize, re-review, or re-certify a merged PR. If the PR was closed without merge, record the terminal transition with stage escalated and stop. Otherwise continue stabilization, record the transition, and report readiness or three-repeat escalation without merging.`,
          {
            auth: stampAutonomous(
              stampRepository(appAuth, run.repository, "github-webhook"),
              run.prNumber
            ),
          }
        );
        waitUntil(
          dispatch.catch((error) => {
            console.error(
              `Pipeline reconciliation failed for ${run.repository} PR #${run.prNumber}.`,
              error
            );
          })
        );
      } catch (error) {
        console.error(
          `Pipeline reconciliation setup failed for ${run.repository} PR #${run.prNumber}.`,
          error
        );
      }
    }
  },
});
