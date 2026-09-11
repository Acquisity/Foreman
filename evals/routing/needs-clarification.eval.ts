import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

export default defineEval({
  description:
    "An ambiguous request asks specific clarifying questions before attempting changes.",
  tags: ["slow"],
  async test(t) {
    await t.send(
      "In Acquisity/Foreman, something is wrong with the emails, you know the one I mean. Fix it properly this time. Ask me what you need to know before investigating or changing anything."
    );
    t.succeeded();
    t.notEvent("subagent.called");
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
    t.judge.autoevals
      .closedQA(
        "Does the submission ask specific questions about which email problem the user means, without claiming to have investigated or fixed it?"
      )
      .soft(0.5);
  },
});
