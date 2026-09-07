import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorProviderFetch } from "#lib/executor/client.js";
import {
  InstantlyApiError,
  instantlyWorkspaceDiscoverySchema,
  listInstantlySubworkspaces,
} from "#lib/instantly-api.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const unavailableReason = (error: unknown): string =>
  error instanceof InstantlyApiError
    ? error.message
    : "Instantly could not run. Check the app-scoped connector configuration.";

export default defineTool({
  description:
    "Find accepted Instantly subworkspaces by a partial name, or browse bounded pages. No workspace ID is needed to search. Validates all Workspace Group pages up to a 100-page safety cap before returning matches; excludes pending and rejected memberships. Returns workspace names and IDs, match totals, and nextStartingAfter for continuation with the same search. Default 20 results, maximum 100 within 256 KiB. Use the matching returned ID with read_instantly_subworkspace; do not guess between ambiguous candidates. Available only on attended investigation surfaces. It never changes Instantly.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized for Instantly investigation reads.",
      };
    }
    try {
      return {
        available: true as const,
        data: await listInstantlySubworkspaces(
          {
            fetch: executorProviderFetch(ctx, "instantly"),
            signal: ctx.abortSignal,
          },
          input
        ),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return { available: false as const, reason: unavailableReason(error) };
    }
  },
  inputSchema: instantlyWorkspaceDiscoverySchema,
  outputSchema: z.object({
    available: z.boolean(),
    data: z
      .object({
        adminWorkspace: z.object({
          id: z.string(),
          name: z.string().nullable(),
        }),
        excludedMemberships: z.object({
          pending: z.number(),
          rejected: z.number(),
        }),
        membershipComplete: z.literal(true),
        nextStartingAfter: z.string().nullable(),
        subworkspaces: z.array(
          z.object({ id: z.string(), name: z.string().nullable() })
        ),
        totalAcceptedSubworkspaces: z.number(),
        totalMatches: z.number(),
      })
      .optional(),
    reason: z.string().optional(),
  }),
});
