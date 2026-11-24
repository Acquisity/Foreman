import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { GAP_AREAS, generalFact } from "#lib/widget-capability-gaps.js";
import { isWidgetSupport, requireWidgetContext } from "../lib/widget-scope.js";

/**
 * The investigator names a fact it needed and no tool returned (ENG-20299).
 * It only records the gap: Foreman's code files the ticket after the reply is
 * saved, with the conversation taken from the verified session.
 */
export const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    'Record a capability gap: a fact you needed to answer the customer that none of your tools returns, or a product question the Help Centre does not cover (kind docs). Call it once per missing fact, after you have tried the tools that should cover it. Never call it for a refusal by design: another workspace\'s data, card details, internal tickets, a feature that is off for this workspace, or something the customer cannot see in the app. A check that failed or timed out is recorded automatically, so do not report those. Write the missing fact in general terms, the same for any customer, with no names, emails, domains, ids, amounts or dates from this workspace, for example "why a domain order is waiting for payment". Recording it changes nothing in your answer: still say plainly what could not be checked.',
  execute: (input, ctx) => {
    requireWidgetContext(ctx.session?.auth.initiator);
    const fact = generalFact(input.missingFact);
    if (!fact) {
      return {
        error:
          "Write the missing fact in general terms, under 160 characters, with no names, emails, domains, ids, numbers or quotes from this workspace, and call again once.",
        recorded: false as const,
      };
    }
    return {
      gap: { area: input.area, fact, kind: input.kind },
      recorded: true as const,
    };
  },
  inputSchema: z.strictObject({
    area: z
      .enum(GAP_AREAS)
      .describe(
        "The product area the missing fact belongs to; help-centre or other when none fits."
      ),
    kind: z
      .enum(["tool", "docs"])
      .describe(
        "tool: no tool returns the fact. docs: the Help Centre does not explain it."
      ),
    missingFact: z.string().trim().min(3).max(400),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
