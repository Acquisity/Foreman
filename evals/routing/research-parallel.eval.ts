import { defineEval } from "eve/evals";
import { calledInOrder } from "../helpers.js";

export default defineEval({
  description:
    "A work item that plainly turns on an external fact sends the researcher out alongside the classifier, and both finish before the analyst plans.",
  tags: ["slow", "needs-connect"],
  async test(t) {
    await t.send(
      "Work item: our date parsing breaks on the new RFC 9557 timezone suffix format; we need to confirm what the released spec actually says and plan a fix. Classify this and produce the implementation plan, but stop after analysis and report the plan to me; do not implement anything yet."
    );
    t.succeeded();
    t.calledSubagent("classifier");
    t.calledSubagent("researcher");
    t.calledSubagent("analyst");
    t.calledSubagent("implementer", { count: 0 });
    t.eventsSatisfy(
      "classifier and researcher are both delegated before the analyst",
      (events) =>
        calledInOrder(events, ["classifier", "analyst"]) &&
        calledInOrder(events, ["researcher", "analyst"])
    );
  },
});
