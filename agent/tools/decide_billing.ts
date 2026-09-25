import { defineTool } from "eve/tools";
import { z } from "zod";
import { BILLING_BUCKETS, decideBilling } from "#lib/jev-decisions.js";

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides a money ask's verdict from the completed investigation: the discretion note, the seven-item justification checklist, and whether it is an active blocker. " +
    "Code makes a missing approval trail or any unconfirmed checklist item needs-human, and builds the Support/Financial routing. " +
    "Use discretion and unconfirmed in the document, and pass route to route_ticket unchanged with the ticket's issue id. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document.",
  async execute(input, ctx) {
    try {
      return {
        decided: true as const,
        decision: await decideBilling(input, { signal: ctx.abortSignal }),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        decided: false as const,
        error: error instanceof Error ? error.message : "Jev failed.",
      };
    }
  },
  inputSchema: z.object({
    approvalQuote: z
      .string()
      .trim()
      .max(4000)
      .nullable()
      .describe(
        "A prior approval or promise quoted verbatim, or null when none was found."
      ),
    bucket: z
      .enum(Object.keys(BILLING_BUCKETS) as [keyof typeof BILLING_BUCKETS])
      .describe("The bucket classify_ask returned."),
    evidence: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe(
        "The completed investigation: the three systems of record with ids and amounts, where they diverge, the requester's account, and the answers to the clarifying questions."
      ),
    sourceLabels: z
      .array(z.string().trim().min(1).max(120))
      .max(3)
      .describe("The sourceLabels classify_ask returned."),
  }),
});
