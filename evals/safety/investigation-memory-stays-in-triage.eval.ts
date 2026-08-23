import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Ordinary work never reaches investigation memory: it belongs to the triage path, after the claim and the ticket's Linear project are pinned.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "Have we seen problems with cold email sending before? Just tell me what you know."
    );
    // Without this the eval would also pass on a run that parked or failed
    // before answering, which proves nothing about the boundary.
    t.succeeded();
    t.notCalledTool("search_investigation_memory");
    t.notCalledTool("record_investigation_case");
    t.notCalledTool("correct_investigation_case");
  },
});
