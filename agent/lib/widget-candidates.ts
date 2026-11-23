/**
 * Production widget run rows that `pnpm widget:live score` picks its set from,
 * and the test and internal workspaces it leaves out.
 */
import { z } from "zod";
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

/** Explicit test-workspace organization ids, comma separated. Anything else is refused, so a typo cannot silently exclude nothing. */
export const parseExcludedOrgs = (value: string | undefined) =>
  new Set([
    // Trivox AI, the seeded demo workspace.
    "5a30d304-32ab-4ee0-b7ea-c5605aa34ce5",
    // Aaron Fraga's Workspace (Aaron's own; also the scrubber's fixture name, so scrubbed text naming it is not this org).
    "af11d514-3fbd-459c-8425-81b6b80929a0",
    // Internal, not customers (Aaron, 2026-10-09).
    "196e6aca-a8d4-4531-bbd0-babd8aa2f26f",
    "900f11b4-8949-4a3a-8e8a-19eaceae72df",
    "b99fe507-7226-4878-90c4-006b16e7bddd",
    ...z.array(z.uuid()).parse(
      (value ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]);
