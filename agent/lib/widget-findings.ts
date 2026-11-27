import type { ChannelSendOptions } from "eve/channels";
import { z } from "zod";
import { GAP_AREAS } from "./widget-capability-gaps.js";

/**
 * Why a chat moves to Fixy (ENG-21094), as Acquisity's handSupportChatToFixy
 * names it. Only Foreman's code sets one; the investigator never does.
 */
export const ESCALATION_REASONS = [
  "asked_for_human",
  "refund",
  "cancel",
  "blocked",
  "cant_check",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** The investigator's only output. It has no customer-facing text field on purpose. */
export const findingsSchema = z.strictObject({
  confidence: z.enum(["low", "medium", "high"]),
  // Acquisity hands the chat to Fixy and files nothing for the escalation.
  escalate: z
    .strictObject({
      reason: z.enum(ESCALATION_REASONS),
      // One plain line naming the problem, for Fixy's top post.
      summary: z.string().min(1).max(200).optional(),
    })
    .optional(),
  facts: z
    .array(
      z.strictObject({
        claim: z.string().min(1).max(2000),
        entityIds: z.array(z.string().max(200)).max(50),
        evidence: z.strictObject({
          ref: z.string().max(500),
          tool: z.string().min(1).max(200),
        }),
      })
    )
    .max(50),
  needsHuman: z.boolean(),
  needsWrite: z.string().max(2000).optional(),
  recommendation: z.string().max(4000),
  report: z.string().min(1).max(1000),
  ticket: z
    .strictObject({
      id: z.string().regex(/^ENG-\d+$/),
      url: z.string().url().max(500),
    })
    .optional(),
  // What the write-up says could not be checked. Foreman's code files these
  // as capability gaps (replyGaps) and drops them before the gate.
  unchecked: z
    .array(
      z.strictObject({
        area: z.enum(GAP_AREAS),
        fact: z.string().min(3).max(160),
        kind: z.enum(["docs", "tool"]),
      })
    )
    .max(10)
    .optional(),
});

export type WidgetFindings = z.infer<typeof findingsSchema>;

export const findingsJsonSchema = z.toJSONSchema(findingsSchema) as NonNullable<
  ChannelSendOptions["outputSchema"]
>;

/** Anything that is not the contract is treated as no findings at all. */
export function parseFindings(value: unknown): WidgetFindings | null {
  const parsed = findingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Findings for a turn that hands the conversation on, to the team or to Fixy:
 * what the turn found, when it found anything, stays for the team-only note.
 */
export const teamFindings = (
  report: string,
  found: WidgetFindings | null | undefined,
  fields: Pick<WidgetFindings, "recommendation"> &
    Partial<Pick<WidgetFindings, "escalate" | "needsWrite" | "ticket">>
) =>
  parseFindings({
    confidence: found?.confidence ?? "low",
    facts: found?.facts ?? [],
    needsHuman: false,
    report: (found?.report ?? report).slice(0, 1000),
    ...fields,
  });
