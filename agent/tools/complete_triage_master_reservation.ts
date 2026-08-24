import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import { completeMasterReservation } from "#lib/investigation-memory/master-reservation.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const linearIssueResponseSchema = z.object({
  data: z.object({
    issue: z.object({
      createdAt: z.iso.datetime(),
      identifier: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export const readLinearMasterCreatedAt = async (
  token: string,
  masterIssueId: string,
  fetcher: FetchLike = fetch
): Promise<string | null> => {
  const response = await fetcher("https://api.linear.app/graphql", {
    body: JSON.stringify({
      query:
        "query TriageMaster($id: String!) { issue(id: $id) { identifier createdAt } }",
      variables: { id: masterIssueId },
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    return null;
  }
  const parsed = linearIssueResponseSchema.safeParse(await response.json());
  if (
    !parsed.success ||
    parsed.data.errors !== undefined ||
    parsed.data.data.issue.identifier !== masterIssueId
  ) {
    return null;
  }
  return parsed.data.data.issue.createdAt;
};

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Complete a causal master reservation after creating the one Linear master and reading back its identifier and createdAt timestamp successfully. The timestamp preserves the evidence needed for later 30-day eligibility decisions. If completion cannot be confirmed, do not create another master; retain the Linear issue identifier and route the mismatch to a person.",
  async execute({ masterIssueId, reservationId }, ctx) {
    if (!canUseInvestigationMemory(ctx.session.auth.current)) {
      return {
        completed: false as const,
        reason: "This session is not authorized to complete a reservation.",
      };
    }
    try {
      const { token } = await ctx.getToken(linearAuth);
      const masterCreatedAt = await readLinearMasterCreatedAt(
        token,
        masterIssueId
      );
      if (masterCreatedAt === null) {
        return {
          completed: false as const,
          reason:
            "The new Linear master could not be read back. Do not create another master.",
        };
      }
      const completed = await completeMasterReservation(
        reservationId,
        masterIssueId,
        masterCreatedAt
      );
      return completed
        ? { completed: true as const }
        : {
            completed: false as const,
            reason:
              "The reservation is absent or already complete. Do not create another master.",
          };
    } catch {
      return {
        completed: false as const,
        reason:
          "The reservation completion could not be confirmed. Do not create another master.",
      };
    }
  },
  inputSchema: z.object({
    masterIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
    reservationId: z.uuid(),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    reason: z.string().optional(),
  }),
});
