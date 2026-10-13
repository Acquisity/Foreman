import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { replayable } from "#lib/widget-replay.js";
import { fileWidgetTicket } from "#lib/widget-ticket.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

export const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "File one internal ticket for this verified support conversation, into Triage. A refund request is filed once the conversation says which charge it is about and why the customer wants it back, and billing has been read; it goes to the billing team, and where it goes is decided from what you write, so say plainly that it is a refund request. A request for a ticket earns an investigation, never a ticket by itself. File only when your investigation gives Engineering something to act on: evidence of a platform fault, or a customer who has already done the right steps and it still fails. When the evidence points to something on the customer's side that they have not tried yet, or you do not yet know what is actually going wrong, do not file: give the fix or ask for what you need, and the ticket can be filed on a later message once that is known. Never file for a how-to question or something a known issue already covers. A support teammate who asks for a ticket gets one. The team, state, workspace and conversation are taken from the verified session, never from this input. A conversation gets one open ticket: if one already exists it is returned instead of a second being created.",
  execute: (input, ctx) => fileWidgetTicket(ctx, input),
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
      isWidgetSupport(ctx.session.auth.initiator)
        ? replayable("widget_file_ticket", tool)
        : null,
  },
});
