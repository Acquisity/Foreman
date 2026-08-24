import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  InstantlyApiError,
  readInstantlySubworkspace,
} from "#lib/instantly-api.js";
import { instantlyApiAuth } from "#lib/instantly-api-auth.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const cursor = z.string().trim().min(1).max(512).optional();
const limit = z.number().int().min(1).max(100).default(20);
const search = z.string().trim().min(1).max(256).optional();
const uuid = z.string().uuid();
const workspace = {
  workspaceId: uuid.optional().describe("The authoritative subworkspace ID."),
  workspaceName: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "An exact subworkspace name. Use only when no workspace ID is available; ambiguous names are rejected."
    ),
};

const inputSchema = z
  .discriminatedUnion("resource", [
    z.object({
      ...workspace,
      limit,
      providerCode: z.number().int().min(1).max(8).optional(),
      resource: z.literal("accounts"),
      search,
      startingAfter: cursor,
      status: z
        .union([
          z.literal(-3),
          z.literal(-2),
          z.literal(-1),
          z.literal(1),
          z.literal(2),
          z.literal(3),
        ])
        .optional(),
    }),
    z.object({
      ...workspace,
      limit,
      resource: z.literal("campaigns"),
      search,
      startingAfter: cursor,
      status: z
        .union([
          z.literal(-99),
          z.literal(-2),
          z.literal(-1),
          z.literal(0),
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
        ])
        .optional(),
    }),
    z.object({
      ...workspace,
      campaignId: uuid.optional(),
      emailAccount: z.string().email().max(320).optional(),
      emailType: z.enum(["received", "sent", "manual"]).optional(),
      latestOfThread: z.boolean().optional(),
      lead: z.string().email().max(320).optional(),
      limit,
      maxTimestampCreated: z.string().datetime().optional(),
      minTimestampCreated: z.string().datetime().optional(),
      resource: z.literal("emails"),
      search,
      startingAfter: cursor,
    }),
  ])
  .superRefine((input, ctx) => {
    if (
      Number(input.workspaceId !== undefined) +
        Number(input.workspaceName !== undefined) !==
      1
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of workspaceId or workspaceName.",
      });
    }
  });

const unavailableReason = (error: unknown): string =>
  error instanceof InstantlyApiError
    ? error.message
    : "Instantly could not run. Check the app-scoped connector configuration.";

export default defineTool({
  description:
    "Read one bounded page of accounts, campaigns, or Unibox email metadata from an accepted Instantly subworkspace. Select by workspace ID when possible. The tool validates the workspace against every Workspace Group page, sends x-as-workspace server-side, and returns workspace name and ID provenance with the next cursor. Email reads force preview-only mode and remove bodies, attachment payloads, and raw address arrays. Available only on attended investigation surfaces. It never creates, updates, deletes, sends, pauses, resumes, replies, or forwards anything.",
  async execute(input, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        available: false as const,
        reason:
          "This session is not authorized for Instantly investigation reads.",
      };
    }
    try {
      const { token } = await ctx.getToken(instantlyApiAuth);
      const { resource, workspaceId, workspaceName, ...query } = input;
      return {
        available: true as const,
        data: await readInstantlySubworkspace(
          token,
          workspaceId === undefined
            ? { name: workspaceName }
            : { id: workspaceId },
          resource,
          query,
          { signal: ctx.abortSignal }
        ),
      };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return { available: false as const, reason: unavailableReason(error) };
    }
  },
  inputSchema,
  outputSchema: z.object({
    available: z.boolean(),
    data: z
      .object({
        items: z.array(z.unknown()),
        nextStartingAfter: z.string().nullable(),
        resource: z.enum(["accounts", "campaigns", "emails"]),
        workspace: z.object({ id: z.string(), name: z.string().nullable() }),
      })
      .optional(),
    reason: z.string().optional(),
  }),
});
