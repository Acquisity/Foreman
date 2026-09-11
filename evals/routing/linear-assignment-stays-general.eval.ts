import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

export default defineEval({
  description:
    "A Linear-assigned planning request is answered without shipping a change or delegating work.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "This issue was assigned to you in Linear. For Acquisity/Foreman, explain how you would investigate an off-by-one pagination error. Reply with the steps only; do not investigate, delegate, edit files, or open a pull request."
    );
    t.succeeded();
    t.notEvent("subagent.called");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
