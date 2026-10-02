import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { decidePriorWork } from "#lib/jev-decisions.js";
import { logOpsEvent } from "#lib/ops-log.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const text = (max: number) => z.string().trim().min(1).max(max);
const ticket = z.object({
  identifier,
  summary: text(1500).describe("Its symptom, cause, and state."),
  title: text(300),
});

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides whether a report continues an existing investigation, reports a known issue, or is fresh, and how each related ticket matches it. " +
    "Code makes a ticket already attached to a master a known issue of that master. " +
    "outcome continuation means reuse the existing investigation. known_issue names the master or same-outcome ticket in knownIssue. fresh means investigate from scratch. " +
    "Each candidate's match is same_outcome, partial_or_adjacent, stale_or_superseded, or not_relevant. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document.",
  async execute(input, ctx) {
    try {
      const decision = await decidePriorWork(input, {
        signal: ctx.abortSignal,
      });
      logOpsEvent("jev.decision", {
        outcome: decision.outcome,
        sessionId: ctx.session.id,
        tool: "decide_prior_work",
      });
      return { decided: true as const, decision };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      logOpsEvent("jev.decision", {
        outcome: "failed",
        sessionId: ctx.session.id,
        tool: "decide_prior_work",
      });
      return {
        decided: false as const,
        error: error instanceof Error ? error.message : "Jev failed.",
      };
    }
  },
  inputSchema: z.object({
    candidates: z
      .array(ticket)
      .max(8)
      .describe("Every hit from find_related_issues worth comparing."),
    existingInvestigation: text(20_000)
      .optional()
      .describe(
        "This ticket's existing investigation findings, when one exists."
      ),
    parent: ticket
      .optional()
      .describe("The master ticket this ticket is attached to, when set."),
    report: text(4000).describe("The testable claim or the reported symptom."),
  }),
});
