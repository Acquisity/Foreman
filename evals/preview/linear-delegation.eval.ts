import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  COMPUTATIONS,
  cancelIssue,
  DELEGATION_ASK,
  fileSandboxIssue,
  finalText,
  marker,
  matchRun,
  previewBuild,
  requireQa,
} from "./helpers.js";

export default defineEval({
  description:
    "L6: a SAN issue asking for two delegated computations gets two children, a wait, and one answer with both results.",
  tags: ["preview"],
  async test(t) {
    requireQa(t, "LINEAR_SANDBOX_API_KEY");
    const build = await previewBuild(t);
    const since = new Date();
    const issue = await fileSandboxIssue(
      `QA ${marker()}: two delegated computations`,
      DELEGATION_ASK
    );
    try {
      t.log(`filed ${issue.identifier}`);
      const runId = await matchRun(
        t,
        build,
        "linear",
        `identifier="${issue.identifier}"`,
        since
      );
      const session = await t.target.attachSession(runId);
      session.succeeded();
      session.calledSubagent("agent", { count: 2, status: "completed" });
      session.calledTool("eve__task_wait");
      session.notCalledTool("sleep");
      await t.require(
        COMPUTATIONS.every(({ line }) =>
          finalText(session.events).includes(line)
        ),
        satisfies(Boolean, "one answer carries both results")
      );
    } finally {
      await cancelIssue(issue.id);
    }
  },
  timeoutMs: 900_000,
});
