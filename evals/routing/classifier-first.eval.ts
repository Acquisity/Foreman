import { defineEval } from "eve/evals";
import { calledInOrder } from "../helpers.js";

export default defineEval({
  description:
    "A work item loads the factory-pipeline skill, enters the pipeline through the classifier before any analysis happens, and an explicit stop-after-analysis instruction keeps the implementer idle.",
  tags: ["slow", "needs-connect"],
  async test(t) {
    await t.send(
      "Use factory mode on Acquisity/Foreman. Users report that password reset emails sometimes arrive twice. Classify, investigate the root cause, and produce the implementation plan, but stop after analysis."
    );
    t.succeeded();
    t.loadedSkill("factory-pipeline");
    t.calledSubagent("classifier");
    t.calledSubagent("investigator");
    t.calledSubagent("analyst");
    t.calledSubagent("implementer", { count: 0 });
    t.eventsSatisfy("classifier is delegated to before the analyst", (events) =>
      calledInOrder(events, ["classifier", "investigator", "analyst"])
    );
  },
});
