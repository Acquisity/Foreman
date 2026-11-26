/**
 * Production widget run rows that `pnpm widget:live score` picks its set from,
 * and the test and internal workspaces it leaves out.
 */
import { z } from "zod";
import { INTERNAL_ORGS } from "./internal-orgs.js";
import { widgetOutcomeSchema } from "./widget-run-store.js";

export const candidateRowSchema = z.object({
  completed_at: z.coerce.date(),
  conversation_id: z.uuid(),
  created_at: z.coerce.date(),
  decision: z.string().nullable(),
  findings: z.unknown().nullable(),
  id: z.uuid(),
  organization_id: z.uuid(),
  // An outcome written by an older build is kept as a turn with no answer.
  outcome: widgetOutcomeSchema.nullable().catch(null),
  question: z.string(),
  scope: z.object({ organizationSlug: z.string().optional() }).catch({}),
  session_id: z.string().nullable(),
});
export type CandidateRow = z.infer<typeof candidateRowSchema>;

/** The internal workspaces plus explicit test-workspace organization ids, comma separated. Anything else is refused, so a typo cannot silently exclude nothing. */
export const parseExcludedOrgs = (value: string | undefined) =>
  new Set([
    ...INTERNAL_ORGS,
    ...z.array(z.uuid()).parse(
      (value ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]);
