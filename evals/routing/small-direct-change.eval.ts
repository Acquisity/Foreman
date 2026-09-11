import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

export default defineEval({
  description:
    "An explanation of a small documentation edit stays direct and performs no writes.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "In Acquisity/Foreman, explain the steps for a tiny README wording correction. Answer directly without delegation. This is a plan only: do not edit files, commit, push, or open a PR."
    );
    t.succeeded();
    t.notEvent("subagent.called");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
