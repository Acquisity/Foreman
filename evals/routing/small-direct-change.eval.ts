import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A small explicit repository documentation edit stays on the direct path and does not invoke factory stations.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "In Acquisity/Foreman, make a tiny README wording correction directly. Do not open a PR or use factory mode; just explain the direct steps you would take."
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
