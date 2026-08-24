import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { investigationMemoryWritePolicy } from "#lib/github/approval.js";
import { completeMasterReservation } from "#lib/investigation-memory/master-reservation.js";
import { canUseInvestigationMemory } from "#lib/trust.js";

const linearIssueResponseSchema = z.object({
  data: z.object({
    master: z.object({
      createdAt: z.iso.datetime(),
      identifier: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
    }),
    source: z.object({
      identifier: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
      parent: z
        .object({
          identifier: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
        })
        .nullable(),
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
  sourceIssueId: string,
  options: { fetcher?: FetchLike; signal?: AbortSignal } = {}
): Promise<string | null> => {
  const timeout = AbortSignal.timeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      "https://api.linear.app/graphql",
      {
        body: JSON.stringify({
          query:
            "query TriageMaster($masterId: String!, $sourceId: String!) { master: issue(id: $masterId) { identifier createdAt } source: issue(id: $sourceId) { identifier parent { identifier } } }",
          variables: { masterId: masterIssueId, sourceId: sourceIssueId },
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      }
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const parsed = linearIssueResponseSchema.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.errors !== undefined ||
    parsed.data.data.master.identifier !== masterIssueId ||
    parsed.data.data.source.identifier !== sourceIssueId ||
    parsed.data.data.source.parent?.identifier !== masterIssueId
  ) {
    return null;
  }
  return parsed.data.data.master.createdAt;
};

export default defineTool({
  approval: investigationMemoryWritePolicy,
  description:
    "Complete a causal master reservation after creating the one Linear master and reading back its identifier, createdAt timestamp, and exact source-parent relationship successfully. The source must match the issue stored on the active reservation. The timestamp preserves the evidence needed for later 30-day eligibility decisions. If completion cannot be confirmed, do not create another master; retain the Linear issue identifier and route the mismatch to a person.",
  async execute({ masterIssueId, reservationId, sourceIssueId }, ctx) {
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
        masterIssueId,
        sourceIssueId,
        { signal: ctx.abortSignal }
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
        sourceIssueId,
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
    sourceIssueId: z.string().regex(/^[A-Z]{2,10}-\d{1,9}$/u),
  }),
  outputSchema: z.object({
    completed: z.boolean(),
    reason: z.string().optional(),
  }),
});
