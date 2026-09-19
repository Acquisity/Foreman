import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { createWidgetTicket } from "#lib/executor/dispatch.js";
import { findRelatedIssues } from "#lib/linear-api.js";
import { isWidgetSupport, requireWidgetContext } from "../lib/widget-scope.js";
import {
  confirmedFinIssue,
  formatFinCustomerReport,
} from "./file_fin_investigation_ticket.js";

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "File one internal Engineering ticket for this verified support conversation, into Triage. Use only after you have investigated and found a platform fault that Engineering must fix, or when the customer or a support teammate explicitly asks you to file one; investigate first so the ticket carries what you found. Never file a ticket for a how-to question, a customer-side setup problem, or something a known issue already covers. The team, state, workspace and conversation are taken from the verified session, never from this input. A conversation gets one ticket: if one already exists it is returned instead of a second being created. When a ticket comes back, end your write-up with this exact line on its own, filled from the result: Ticket filed: <identifier> <url>. That line is how the ticket is linked to the conversation; without it the customer is told no ticket was opened. It is the only place a ticket number may appear.",
  async execute(input, ctx) {
    const scope = requireWidgetContext(ctx.session.auth.initiator);
    try {
      // One ticket per conversation: every widget ticket carries the conversation
      // id in its server-written scope block, so an earlier one is found by it.
      const earlier = await findRelatedIssues(
        {
          phrases: [scope.conversationId],
          scope: "duplicates",
          windowed: false,
        },
        { client: executorClient(ctx), signal: ctx.abortSignal }
      );
      const [existing] = earlier.issues;
      if (existing) {
        return {
          existing: true,
          identifier: existing.identifier,
          url: existing.url,
        };
      }
      const result = await createWidgetTicket(ctx, {
        report: formatFinCustomerReport(input.summary),
        title: input.title,
      });
      if (!result.ok) {
        return { error: "Linear did not accept the ticket." };
      }
      try {
        return { existing: false, ...confirmedFinIssue(result.data) };
      } catch {
        return {
          error:
            "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
        };
      }
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error:
          "The ticket outcome could not be confirmed. Do not retry automatically.",
      };
    }
  },
  inputSchema: z.strictObject({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe(
        "What the customer is trying to achieve, what was tried, what is happening instead, and the expected outcome, with the evidence you found."
      ),
    title: z.string().trim().min(1).max(160),
  }),
  outputSchema: z.union([
    z.object({
      existing: z.boolean(),
      identifier: z.string(),
      url: z.string(),
    }),
    z.object({ error: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
