import type { ChannelSendOptions } from "eve/channels";
import { z } from "zod";

/** The investigator's only output. It has no customer-facing text field on purpose. */
export const findingsSchema = z.strictObject({
  confidence: z.enum(["low", "medium", "high"]),
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
  ticket: z
    .strictObject({
      id: z.string().regex(/^ENG-\d+$/),
      url: z.string().url().max(500),
    })
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
