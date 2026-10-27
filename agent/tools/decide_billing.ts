import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { BILLING_BUCKETS, decideBilling } from "#lib/jev-decisions.js";
import { billingDecisionFields, triageDecisions } from "#lib/triage-log.js";

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides a money ask's verdict from the completed investigation: the discretion note, the seven-item justification checklist, and whether it is an active blocker. " +
    "Code makes a missing approval trail or any unconfirmed checklist item needs-human, and builds the Support/Financial routing. " +
    "Use discretion and unconfirmed in the document, pass the ticket's issue id here, and pass route to route_ticket unchanged with the same issue id. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document.",
  async execute(input, ctx) {
    try {
      const { issue, ...billing } = input;
      const decision = await decideBilling(billing, {
        signal: ctx.abortSignal,
      });
      if (issue) {
        triageDecisions.update((decisions) => ({
          ...decisions,
          [issue]: billingDecisionFields(issue, {
            assignee: decision.route.assignee,
            project: decision.route.project,
          }),
        }));
      }
      return { decided: true as const, decision };
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
        "The completed investigation: the three systems of record with ids and amounts, where they diverge, the requester's account, and any facts the requester volunteered."
      ),
    issue: z
      .string()
      .trim()
      .regex(LINEAR_ISSUE_ID_PATTERN)
      .optional()
      .describe(
        "The ticket's issue id, such as ENG-123, when the ticket exists. Leave it out only when you create the ticket after this decision."
      ),
    sourceLabels: z
      .array(z.string().trim().min(1).max(120))
      .max(3)
      .describe("The sourceLabels classify_ask returned."),
  }),
});
