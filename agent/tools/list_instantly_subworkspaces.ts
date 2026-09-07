import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorProviderFetch } from "#lib/executor/client.js";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
} from "#lib/instantly-api.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const unavailableReason = (error: unknown): string =>
  error instanceof InstantlyApiError
    ? error.message
    : "Instantly could not run. Check the app-scoped connector configuration.";

export default defineTool({
  description:
    "List accepted Instantly subworkspaces available to Acquisity's IBG admin workspace. This follows up to 100 Workspace Group pages, fails instead of returning a partial list at that safety cap, excludes pending and rejected memberships, and returns the admin and subworkspace names and IDs. Available only on attended investigation surfaces. It never changes Instantly.",
  async execute(_input, ctx) {
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
        data: await listInstantlySubworkspaces({
          fetch: executorProviderFetch(ctx, "instantly"),
          signal: ctx.abortSignal,
        }),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return { available: false as const, reason: unavailableReason(error) };
    }
  },
  inputSchema: z.object({}),
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
        subworkspaces: z.array(
          z.object({ id: z.string(), name: z.string().nullable() })
        ),
      })
      .optional(),
    reason: z.string().optional(),
  }),
});
