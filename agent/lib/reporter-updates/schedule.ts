import { getToken as getConnectToken } from "@vercel/connect";
import { GITHUB_CONNECTOR } from "../github/credentials.js";
import { logOpsEvent } from "../ops-log.js";
import { reporterUpdatesConfig } from "./config.js";
import { withDeadline } from "./deadline.js";
import { githubDeployProbe } from "./deploy.js";
import { linearPort } from "./linear.js";
import { runReporterUpdates } from "./run.js";
import { databaseReporterStore } from "./store.js";
import { reporterWriter } from "./writer.js";

const TOKEN_DEADLINE_MS = 15_000;
const LINEAR_SCOPES = ["read", "write", "issues:create", "comments:create"];

export const runScheduledReporterUpdates = async (): Promise<void> => {
  const config = reporterUpdatesConfig();
  if (!config) {
    return;
  }
  const linearToken = await withDeadline(
    () =>
      getConnectToken(process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent", {
        scopes: LINEAR_SCOPES,
        subject: { type: "app" },
      }),
    TOKEN_DEADLINE_MS
  );
  const report = await runReporterUpdates(
    {
      config,
      deploy: githubDeployProbe(() =>
        getConnectToken(GITHUB_CONNECTOR, { subject: { type: "app" } })
      ),
      linear: linearPort(linearToken),
      store: databaseReporterStore(),
      write: reporterWriter(),
    },
    Date.now()
  );
  for (const { outcome } of report.outcomes) {
    if (outcome.kind === "posted") {
      logOpsEvent("reporter.update", {
        decision: outcome.stage,
        outcome: "posted",
      });
    }
  }
  if (report.errors.length > 0) {
    logOpsEvent("reporter.update.failed", {
      code: String(report.errors.length),
      outcome: "error",
    });
  }
};
