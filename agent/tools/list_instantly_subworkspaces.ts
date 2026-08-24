import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
} from "#lib/instantly-api.js";
import { instantlyApiAuth } from "#lib/instantly-api-auth.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const unavailableReason = (error: unknown): string =>
  error instanceof InstantlyApiError
    ? error.message
    : "Instantly could not run. Check the app-scoped connector configuration.";

export default defineTool({
  description:
    "List every accepted Instantly subworkspace available to Acquisity's IBG admin workspace. This follows every Workspace Group page, excludes pending and rejected memberships, and returns the admin and subworkspace names and IDs. Available only on attended investigation surfaces. It never changes Instantly.",
  async execute(_input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized for Instantly investigation reads.",
      };
    }
    try {
      const { token } = await ctx.getToken(instantlyApiAuth);
      return {
        available: true as const,
        data: await listInstantlySubworkspaces(token, {
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
