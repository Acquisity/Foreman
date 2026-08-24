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
  LIVE_FEATURE_KEYS,
  MAX_SCOPE_ENTRIES,
} from "#lib/investigation-memory/scope.js";
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEARCH_WINDOW_DAYS,
  MAX_SEARCH_LIMIT,
  searchCases,
  searchCasesAcrossLiveFeatures,
} from "#lib/investigation-memory/store.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

export default defineTool({
  description:
    "Search past Foreman triage investigations after the current claim is stated. With a Linear project id, search its mapped product scope. Without one, an authorized attended Intercom intake searches all six live core-product areas and excludes planned products. Results are historical analogies, never current truth: verify every match against current code, production data, and runtime evidence. Project-free incident signals are grouped per product area and never combine unrelated products. When `available` is false, continue from current evidence.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized to read investigation memory. Investigate from current evidence.",
      };
    }

    try {
      if (input.linearProjectId === undefined) {
        if (input.sourceIssueId !== undefined) {
          return {
            available: false as const,
            reason:
              "A ticket identity lookup still needs its Linear project. Use project-free search only for a live Intercom claim before a ticket exists.",
          };
        }
        const { cases, clusters } = await searchCasesAcrossLiveFeatures({
          classification: input.classification,
          component: input.component,
          dependencyKeys: input.dependencyKeys,
          limit: input.limit,
          provider: input.provider,
          text: input.text,
          windowDays: input.windowDays,
        });
        return {
          available: true as const,
          cases,
          clusters,
          searchedFeatureKeys: [...LIVE_FEATURE_KEYS],
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
    linearProjectId: z
      .uuid()
      .optional()
      .describe(
        "The Linear project id read off the current issue. Omit only for an authorized live Intercom intake before a Linear issue exists; that searches the server-owned list of live product areas."
      ),
    provider: z.string().trim().min(1).max(60).optional(),
    sourceIssueId: z
      .string()
      .trim()
      .regex(/^[A-Z]{2,10}-\d{1,9}$/)
      .optional()
      .describe(
        "Look up one ticket's own case, for example before correcting it. This is an identity lookup: it ignores the other filters and the time window, so ranking, the result limit, and an old case cannot hide it."
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
    primaryFeatureKey: z.enum(FEATURE_KEYS).optional(),
    reason: z.string().optional(),
    searchedFeatureKeys: z.array(z.enum(FEATURE_KEYS)).optional(),
  }),
});
