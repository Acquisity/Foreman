import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { decideTriage } from "#lib/jev-decisions.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const text = (max: number) => z.string().trim().min(1).max(max);

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides the Stage 5 handling for a triage ticket from the completed Stage 4 evidence record: verdict, classification, duplicate, handling path, final state, priority, labels, and project. " +
    "Code applies the Bug bar, the state for each path, the priority rules, and the Aaron fallback. " +
    "outcome unproven means take the unproven branch with the missing confirmations it lists. " +
    "outcome route carries the exact state, priority, addLabels, project, and duplicate fields for route_ticket; pass them unchanged. assignee 'area owner' means the roster owner for the chosen project. " +
    "Put every note in the Triage investigation document. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document.",
  async execute(input, ctx) {
    try {
      return {
        decided: true as const,
        decision: await decideTriage(input, { signal: ctx.abortSignal }),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        decided: false as const,
        error: error instanceof Error ? error.message : "Jev failed.",
      };
    }
  },
  inputSchema: z.object({
    blastRadius: z
      .object({
        countedAt: text(40).describe("The date the count ran."),
        orgs: z.number().int().min(0),
        query: text(4000).describe("The query that produced the count."),
        users: z.number().int().min(0),
      })
      .optional()
      .describe("Only when a query counted it; omit an estimate."),
    claim: text(1000).describe("The one testable sentence from Stage 1."),
    codePath: z
      .object({
        commit: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/u),
        file: text(300),
        function: text(200),
      })
      .optional()
      .describe("The file and function the cause runs through, when found."),
    duplicateCandidates: z
      .array(
        z.object({
          identifier,
          priority: z
            .number()
            .int()
            .min(1)
            .max(4)
            .optional()
            .describe("The candidate's current priority."),
          summary: text(1500).describe("Its symptom, cause, and state."),
          title: text(300),
        })
      )
      .max(8)
      .describe("Every hit from find_related_issues worth comparing."),
    evidence: text(20_000).describe(
      "The Stage 4 evidence record: every lane with what it returned, contrary evidence, the unblock, and what was ruled out."
    ),
    identifier: identifier.describe(
      "The ticket being triaged, such as ENG-123."
    ),
    projects: z
      .array(z.object({ description: text(300).optional(), name: text(120) }))
      .min(1)
      .max(40)
      .describe("The team's active product projects, read from Linear now."),
    rootCauseLabels: z
      .array(text(120))
      .max(40)
      .describe("The team's Root Cause label names, read from Linear now."),
    sourceLabels: z
      .array(text(120))
      .max(3)
      .describe("The sourceLabels classify_ask returned."),
  }),
});
