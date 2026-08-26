import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CLASSIFICATIONS,
  caseProjectionSchema,
  SOURCE_ISSUE_ID_HINT,
  SOURCE_ISSUE_ID_PATTERN,
} from "#lib/investigation-memory/case.js";
import {
  FEATURE_KEYS,
  isDependencyKey,
  LIVE_FEATURE_KEYS,
  MAX_SCOPE_ENTRIES,
} from "#lib/investigation-memory/scope.js";
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_WINDOW_DAYS,
  MAX_SEARCH_LIMIT,
  searchCasesGlobally,
} from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  description:
    "Search past Foreman investigations after the current claim or question is stated: Linear triage cases, ticketless Intercom and Slack investigations, and conclusions a human corrected in a thread. Every authorized attended surface searches the server-owned live product areas; Linear project metadata is neither accepted nor required. Results are historical analogies, never current truth: verify every match against current code, production data, and runtime evidence, and lead with a recorded resolution only as the thing to check first. Incident signals are grouped per product area and never combine unrelated products. When `available` is false, continue from current evidence.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized to read investigation memory. Investigate from current evidence.",
      };
    }

    try {
      const { cases, clusters } = await searchCasesGlobally({
        classification: input.classification,
        component: input.component,
        dependencyKeys: input.dependencyKeys,
        limit: input.limit,
        provider: input.provider,
        sourceIssueId: input.sourceIssueId,
        text: input.text,
        windowDays: input.windowDays,
      });
      return {
        available: true as const,
        cases,
        clusters,
        ...(input.sourceIssueId === undefined
          ? { searchedFeatureKeys: [...LIVE_FEATURE_KEYS] }
          : {}),
      };
    } catch (error) {
      console.error("Investigation memory search failed.", error);
      return {
        available: false as const,
        reason: "Continue from current evidence.",
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
    provider: z.string().trim().min(1).max(60).optional(),
    sourceIssueId: z
      .string()
      .trim()
      .regex(SOURCE_ISSUE_ID_PATTERN, SOURCE_ISSUE_ID_HINT)
      .optional()
      .describe(
        `Look up one source's own case, for example before correcting it. ${SOURCE_ISSUE_ID_HINT} This is an identity lookup: it ignores the other filters and the time window, so ranking, the result limit, and an old case cannot hide it.`
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
    clusters: z
      .array(
        z.object({
          distinctFeatures: z.number(),
          firstSeen: z.string().nullable(),
          lastSeen: z.string().nullable(),
          possibleWiderIncident: z.boolean(),
          primaryFeatureKey: z.enum(FEATURE_KEYS),
          reports: z.number(),
          windowDays: z.number(),
        })
      )
      .optional(),
    reason: z.string().optional(),
    searchedFeatureKeys: z.array(z.enum(FEATURE_KEYS)).optional(),
  }),
});
