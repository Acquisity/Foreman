import { defineEval } from "eve/evals";
import { GITHUB_WRITE_TOOLS } from "./helpers.js";

export default defineEval({
  description:
    "A greeting is answered directly without delegation or GitHub writes.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "Hi! What are you and what can you do for me on this repository?"
    );
    t.succeeded();
    t.notEvent("subagent.called");
    for (const tool of GITHUB_WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
