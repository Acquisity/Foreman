import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "An attended product-behavior question searches investigation memory, and a question alone never writes to it.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "Have we seen problems with cold email sending before? Just tell me what you know."
    );
    // Without this the eval would also pass on a run that parked or failed
    // before answering, which proves nothing about the boundary.
    t.succeeded();
    t.calledTool("search_investigation_memory");
    t.notCalledTool("record_investigation_case");
    t.notCalledTool("correct_investigation_case");
  },
});
