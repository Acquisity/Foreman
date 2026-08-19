import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A complex, security-sensitive repository migration may select factory mode based on the skill routing description, not merely because it touches files.",
  tags: ["slow"],
  async test(t) {
    await t.send(
      "For Acquisity/Foreman, redesign tenant authorization across the webhook, tool, and persistence boundaries. This is a high-risk migration and I want independent root-cause investigation and review before a pull request. Stop after classification."
    );
    t.succeeded();
    t.loadedSkill("factory-pipeline");
    t.calledSubagent("classifier");
  },
});
