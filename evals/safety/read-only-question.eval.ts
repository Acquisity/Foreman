import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

export default defineEval({
  description:
    "A read-only question about the repository is answered with read tools alone: no GitHub write is attempted and no delegated work runs.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "In Acquisity/Foreman, what is the repository about and what does its README say about getting started? Answer directly without delegation."
    );
    t.succeeded();
    t.notEvent("subagent.called");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
