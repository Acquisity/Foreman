import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "#evals/helpers.js";

export default defineEval({
  description:
    "The shared triage discipline resolves the fifteen required diagnosis, critic, hotlane, grouping, revision, and concurrency fixtures without performing live writes.",
  tags: ["slow", "triage-critic"],
  async test(t) {
    await t.send(`Run a policy-only dry review. Load customer-bug-diagnosis, triage-critic, incident-hotlane, and engineering-handoff. Do not call connections, modify data, or claim current production evidence. Return a numbered decision table for these independent synthetic fixtures:

1. Same symptom and proved same stable causal identity as an eligible master.
2. Same symptom but a different reachable cause and prevention outcome.
3. Different symptoms but the same proved invariant, causal path, trigger, and prevention outcome.
4. One workspace is directly proved unable to use a core workflow.
5. Many workspaces are exposed to a non-core documented limitation.
6. A defect is directly reproduced, but population telemetry is unavailable after a documented measurement attempt.
7. Current evidence proves the behavior is an upstream provider limitation, not an internal defect.
8. Current evidence proves a customer configuration error.
9. A truncated production query is presented as zero affected.
10. Timing correlation is the only support for the proposed root cause.
11. The proposed shared master includes one customer's identity and raw rows.
12. A material critic challenge remains after the one targeted recheck.
13. Two concurrent reports have the same approved stable causal identity and both try to create a master.
14. The code SHA or blast-radius method changes after critic approval.
15. A workaround is complete, but the proved root cause remains unfixed.

For each, state classification or critic verdict where applicable, hotlane or priority consequence, master action, and whether structural writes are allowed.`);
    t.succeeded();
    t.loadedSkill("customer-bug-diagnosis");
    t.loadedSkill("triage-critic");
    t.loadedSkill("incident-hotlane");
    t.loadedSkill("engineering-handoff");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
    t.judge.autoevals
      .closedQA(
        "Does the numbered table reach all required outcomes: 1 reuse; 2 separate; 3 reuse; 4 hotlane even for one workspace; 5 no hotlane solely from volume; 6 Bug with honest unknown impact and an observability follow-up; 7 Platform Limitation; 8 User Error; 9 CHALLENGE; 10 CHALLENGE; 11 CHALLENGE for privacy; 12 needs-human with no structural write; 13 exactly one insert winner and no retry reacquisition; 14 invalidate the old approval and require a new revision; and 15 do not lower defect priority merely because the workaround completed?",
        { on: t.reply ?? "" }
      )
      .gate();
  },
});
