import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Ordinary conversation remains in general mode even when it mentions code repositories.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "For Acquisity/Foreman, what is the difference between a feature branch and a pull request? Answer only; this is not a work item."
    );
    t.succeeded();
    t.loadedSkill("factory-pipeline", { count: 0 });
    t.calledSubagent("classifier", { count: 0 });
  },
});
