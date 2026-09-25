import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { createWidgetTicket, REFUND_TICKET } from "#lib/executor/dispatch.js";
import {
  findRelatedIssues,
  type LinearGraphqlOptions,
  linearGraphql,
  type RelatedIssue,
} from "#lib/linear-api.js";
import { isRefundTicket } from "#lib/widget-next-action.js";
import { isWidgetSupport, requireWidgetContext } from "../lib/widget-scope.js";
import {
  confirmedFinIssue,
  formatFinCustomerReport,
} from "./file_fin_investigation_ticket.js";

/** REFUND_TICKET.project (P-ENG-20, "Support") as the id Linear returns for an issue's project. */
const SUPPORT_PROJECT_ID = "4534deb2-6bbc-4e30-ad38-48963f414d14";

interface RoutedIssue {
  issue: {
    labels: { nodes: { id: string }[] };
    project: { id: string } | null;
  } | null;
}

/**
 * Whether an existing ticket already sits in the queue billing triage reads:
 * the Support project with the Refund label, the destination REFUND_TICKET
 * files to. A ticket that cannot be read counts as not routed.
 */
export async function inRefundQueue(
  identifier: string,
  opts: LinearGraphqlOptions
): Promise<boolean> {
  try {
    const { issue } = await linearGraphql<RoutedIssue>(
      "RouteIssue",
      { id: identifier },
      opts
    );
    return Boolean(
      issue?.project?.id === SUPPORT_PROJECT_ID &&
        issue.labels.nodes.some(({ id }) => id === REFUND_TICKET.labels[0])
    );
  } catch (error) {
    if (opts.signal?.aborted) {
      throw error;
    }
    return false;
  }
}

/**
 * A conversation's existing ticket is returned instead of a second one. It
 * counts as routed to billing only when it is verified in the refund queue;
 * an ordinary ticket reused for a refund leaves the handoff to a person.
 */
export const existingTicket = (
  issue: Pick<RelatedIssue, "identifier" | "url">,
  routedRefund: boolean
) => ({
  existing: true,
  identifier: issue.identifier,
  refund: routedRefund,
  url: issue.url,
});

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
        const opts = { client: executorClient(ctx), signal: ctx.abortSignal };
        return existingTicket(
          existing,
          refund && (await inRefundQueue(existing.identifier, opts))
        );
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
