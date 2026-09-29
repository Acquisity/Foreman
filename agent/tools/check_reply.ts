import { defineTool } from "eve/tools";
import { z } from "zod";
import { checkGrounding } from "#lib/jev-grounding.js";
import { logOpsEvent } from "#lib/ops-log.js";

const text = (max: number) => z.string().trim().min(1).max(max);

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev checks a draft final reply against the evidence this turn gathered: which claims the evidence does not show, and which say work is done without evidence that it is. " +
    "It never stops the reply. reply is the draft with each flagged claim marked unconfirmed; send it, or first adjust each flagged claim yourself (remove it, mark it unconfirmed, or back it with evidence you already have), then send. " +
    "checked false means the draft could not be fully checked (including more than 40 claims): send it unchanged.",
  async execute(input, ctx) {
    const result = await checkGrounding(input, { signal: ctx.abortSignal });
    let outcome = "failed";
    if (result.checked) {
      outcome = result.flagged.length > 0 ? "flagged" : "clean";
    }
    logOpsEvent("jev.decision", {
      outcome,
      requests: result.flagged.length,
      sessionId: ctx.session.id,
      tool: "check_reply",
    });
    return result;
  },
  inputSchema: z.object({
    draft: z
      .string()
      .min(1)
      .max(20_000)
      .describe("The reply exactly as you would send it."),
    evidence: text(20_000).describe(
      "What this turn's tools and reads actually showed: ids, counts, results, and what could not be checked."
    ),
  }),
});
