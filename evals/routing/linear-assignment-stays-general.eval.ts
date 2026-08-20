import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A Linear-assigned work item stays in general mode by default: it does not load the factory-pipeline skill or delegate to any station.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "This issue was assigned to you in Linear. For Acquisity/Foreman, fix the off-by-one error in the pagination helper."
    );
    t.succeeded();
    t.loadedSkill("factory-pipeline", { count: 0 });
    for (const station of [
      "classifier",
      "investigator",
      "analyst",
      "implementer",
      "reviewer",
    ]) {
      t.calledSubagent(station, { count: 0 });
    }
  },
});
