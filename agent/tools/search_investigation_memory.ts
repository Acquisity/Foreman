import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CLASSIFICATIONS,
  caseProjectionSchema,
} from "#lib/investigation-memory/case.js";
import {
  FEATURE_KEYS,
  featureForProject,
  isDependencyKey,
  MAX_SCOPE_ENTRIES,
} from "#lib/investigation-memory/scope.js";
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_WINDOW_DAYS,
  MAX_SEARCH_LIMIT,
  searchCases,
} from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  description:
    "Search past Foreman triage investigations for cases in the same product scope. Call it only after the current claim and the ticket's Linear project are pinned. Results are historical analogies, never current truth: every match still has to be verified against current code, production data, and runtime evidence, and a historical affected count is never the current blast radius. `possibleWiderIncident` means several independent recent tickets share this scope, which is a prompt to check current telemetry, not an outage. When `available` is false, continue the investigation from scratch.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized to read investigation memory. Investigate from current evidence.",
      };
    }

    const primaryFeatureKey = featureForProject(input.linearProjectId);
    if (primaryFeatureKey === null) {
      return {
        available: false as const,
        reason:
          "That Linear project is not mapped to a product area, so there is no scope to search. Investigate from current evidence and route the ticket to Aaron Fraga as the triage skill already requires.",
      };
    }

    try {
      const { cases, cluster } = await searchCases({
        classification: input.classification,
        component: input.component,
        dependencyKeys: input.dependencyKeys,
        limit: input.limit,
        primaryFeatureKey,
        provider: input.provider,
        sourceIssueId: input.sourceIssueId,
        text: input.text,
        windowDays: input.windowDays,
      });
      return { available: true as const, cases, cluster, primaryFeatureKey };
    } catch (error) {
      return {
        available: false as const,
        reason: error instanceof Error ? error.message : "Search failed.",
      };
    }
  },
  inputSchema: z.object({
    classification: z.enum(CLASSIFICATIONS).optional(),
    component: z.string().trim().min(1).max(80).optional(),
    dependencyKeys: z
      .array(z.string().trim().max(40).refine(isDependencyKey))
      .max(MAX_SCOPE_ENTRIES)
      .optional()
      .describe(
        "Shared systems the claim runs through, when they are known: instantly, webhooks, inngest."
      ),
    limit: z.int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
    linearProjectId: z
      .uuid()
      .describe(
        "The Linear project id read off the current issue. It picks the product scope; nothing else may."
      ),
    provider: z.string().trim().min(1).max(60).optional(),
    sourceIssueId: z
      .string()
      .trim()
      .regex(/^[A-Z]{2,10}-\d{1,9}$/)
      .optional()
      .describe(
        "Narrow to one ticket's own case, for example before correcting it. Ranking and the result limit cannot hide it."
      ),
    text: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe(
        "The current claim, symptom, or error signature, in the product's own words."
      ),
    windowDays: z
      .int()
      .min(1)
      .max(1095)
      .default(DEFAULT_SEARCH_WINDOW_DAYS)
      .describe("How far back to look."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    cases: z.array(caseProjectionSchema).optional(),
    cluster: z
      .object({
        distinctFeatures: z.number(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable(),
        possibleWiderIncident: z.boolean(),
        reports: z.number(),
        windowDays: z.number(),
      })
      .optional(),
    primaryFeatureKey: z.enum(FEATURE_KEYS).optional(),
    reason: z.string().optional(),
  }),
});
