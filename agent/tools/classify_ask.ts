import { defineTool } from "eve/tools";
import { z } from "zod";
import { BILLING_BUCKETS, decideAskKind } from "#lib/jev-decisions.js";

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides whether a report is a money ask or a product ask, which billing bucket a money ask falls in, and which source labels apply. " +
    "Call it once with the report text before choosing the triage or billing procedure, and follow its answer. " +
    "kind unclear means ask the requester one batched question that places it. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document.",
  async execute({ report }, ctx) {
    try {
      return {
        decided: true as const,
        ...(await decideAskKind(report, { signal: ctx.abortSignal })),
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
    report: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe(
        "The report as written: title, description, and the requester's comments or conversation, plus where it came from (Linear, Slack, Intercom)."
      ),
  }),
  outputSchema: z.object({
    bucket: z
      .enum(Object.keys(BILLING_BUCKETS) as [string, ...string[]])
      .nullable()
      .optional(),
    confidence: z.number().optional(),
    decided: z.boolean(),
    error: z.string().optional(),
    kind: z.enum(["money", "product", "unclear"]).optional(),
    sourceLabels: z.array(z.string()).optional(),
  }),
});
