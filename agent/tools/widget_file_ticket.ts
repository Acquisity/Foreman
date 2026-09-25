import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { createWidgetTicket } from "#lib/executor/dispatch.js";
import { findRelatedIssues } from "#lib/linear-api.js";
import { isRefundTicket } from "#lib/widget-next-action.js";
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
    "File one internal ticket for this verified support conversation, into Triage. A refund request is filed once the conversation says which charge it is about and why the customer wants it back, and billing has been read; it goes to the billing team, and where it goes is decided from what you write, so say plainly that it is a refund request. A request for a ticket earns an investigation, never a ticket by itself. File only when your investigation gives Engineering something to act on: evidence of a platform fault, or a customer who has already done the right steps and it still fails. When the evidence points to something on the customer's side that they have not tried yet, or you do not yet know what is actually going wrong, do not file: give the fix or ask for what you need, and the ticket can be filed on a later message once that is known. Never file for a how-to question or something a known issue already covers. A support teammate who asks for a ticket gets one. The team, state, workspace and conversation are taken from the verified session, never from this input. A conversation gets one open ticket: if one already exists it is returned instead of a second being created.",
  async execute(input, ctx) {
    const scope = requireWidgetContext(ctx.session.auth.initiator);
    try {
      const refund = await isRefundTicket(input, ctx.abortSignal);
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
      // A ticket someone cancelled no longer covers this conversation.
      const [existing] = earlier.issues.filter(
        (issue) => issue.stateType !== "canceled"
      );
      if (existing) {
        return {
          existing: true,
          identifier: existing.identifier,
          refund,
          url: existing.url,
        };
      }
      const result = await createWidgetTicket(ctx, {
        refund,
        report: formatFinCustomerReport(input.summary),
        title: input.title,
      });
      if (!result.ok) {
        return { error: "Linear did not accept the ticket." };
      }
      try {
        return { existing: false, refund, ...confirmedFinIssue(result.data) };
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
      refund: z.boolean(),
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
