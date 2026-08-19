import { defineEval } from "eve/evals";
import { calledInOrder, STATIONS } from "../helpers.js";

export default defineEval({
  description:
    "An explicit scratch-repository work item runs the complete factory line and delivers an internally approved normal pull request. Opt-in because it pushes a real branch.",
  tags: ["slow", "needs-connect", "pipeline"],
  async test(t) {
    const repository = process.env.PIPELINE_SCRATCH_REPO;
    if (!repository) {
      t.skip("Set PIPELINE_SCRATCH_REPO to an owner/repo scratch repository.");
      return;
    }
    await t.send(
      `Use factory mode on ${repository}. Add a short Reporting bugs section to the README that asks reporters to include their version and reproduction steps. Run the full pipeline and deliver a normal pull request.`
    );
    t.succeeded();
    for (const station of STATIONS) {
      t.calledSubagent(station);
    }
    t.eventsSatisfy("stations ran in pipeline order", (events) =>
      calledInOrder(events, [...STATIONS])
    );
    t.judge.autoevals
      .closedQA(
        "Does the submission name a concrete branch or normal pull request and report the independent review verdict without claiming to merge it?"
      )
      .atLeast(0.5);
  },
  timeoutMs: 1_800_000,
});
