import { customerMessages } from "./widget-instructions.js";

/** The customer asks for money back or disputes a charge, in their own words. */
const DISPUTE =
  /\b(?:refund\w*|reimburs\w*|money back|charge ?back|disput\w*|over-?(?:charg|invoic|bill)\w*|charged (?:me )?twice|double[- ]charg\w*)/iu;

/** A tool result as the model saw it: a JSON string, or already parsed. */
const outputOf = (result: unknown): unknown => {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  const typed = value as { type?: string; value?: unknown } | null;
  return typed?.type === "json" ? typed.value : value;
};

/** An endpoint result's section, or nothing when the tool is another one. */
const endpointSection = (
  tool: string,
  output: unknown,
  endpointTool: string,
  section: string
) =>
  tool === endpointTool
    ? ((output as { sections?: Record<string, unknown> | null } | null)
        ?.sections?.[section] as Record<string, unknown> | null | undefined)
    : undefined;

/**
 * Follow-ups went out before their delay: the campaigns endpoint's
 * `earlyFollowUps` section (ENG-20548), or each campaign's diagnostics from
 * the old hand-written campaigns tool while campaigns is held.
 */
const earlyFollowUpFault = (tool: string, output: unknown) =>
  endpointSection(tool, output, "widget_campaigns", "earlyFollowUps")
    ?.platformFault === true ||
  (tool === "widget_outreach_health" &&
    ((
      output as {
        campaigns?: {
          diagnostics?: {
            earlyFollowUps?: { platformFault?: boolean } | null;
          } | null;
        }[];
      } | null
    )?.campaigns?.some(
      (campaign) => campaign.diagnostics?.earlyFollowUps?.platformFault === true
    ) ??
      false));

/** The billing read names the charges a dispute is about: the billing endpoint's `inboxErrorCharges` section (ENG-20547). */
const identifiesCharge = (tool: string, output: unknown) =>
  endpointSection(tool, output, "widget_billing", "inboxErrorCharges")
    ?.identifiesCharge === true;

/**
 * The ticket the reads already settle, decided in code before Jev is asked.
 * Jev picked `ticket` 2 times in 60 live runs and missed both clear cases
 * (ENG-15044 round 15): wrun ...MAF4Z47, a refund ask whose billing reading
 * names the inbox charges billed while broken, where it asked which domains;
 * and wrun ...4W6NAN, follow-ups sent days before their delay. A tool marks
 * those readings with a field (`identifiesCharge`, `platformFault`), never text.
 */
export function ruledTicket(
  question: string,
  reads: { result: unknown; tool: string }[]
): "billing" | "fault" | null {
  const results = reads.map((read) => ({
    output: outputOf(read.result),
    tool: read.tool,
  }));
  if (results.some(({ tool, output }) => earlyFollowUpFault(tool, output))) {
    return "fault";
  }
  // The latest message only: an earlier turn's dispute already had its ticket.
  return DISPUTE.test(
    customerMessages(question.split("\nEARLIER TURNS (")[0] ?? "")
  ) && results.some(({ tool, output }) => identifiesCharge(tool, output))
    ? "billing"
    : null;
}
