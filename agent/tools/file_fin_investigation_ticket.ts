import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { createFinInvestigationTicket } from "#lib/executor/dispatch.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";

const issueUrl = /^https:\/\/linear\.app\/acquisity\/issue\/(ENG-\d+)(?:\/|$)/u;
const issueIdentifier = /^ENG-\d+$/u;

const findIssue = (
  value: unknown
): { identifier: string; url: string } | null => {
  if (typeof value === "string") {
    try {
      return findIssue(JSON.parse(value));
    } catch {
      const match = issueUrl.exec(value);
      return match ? { identifier: match[1], url: match[0] } : null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const issue = findIssue(item);
      if (issue) {
        return issue;
      }
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.identifier === "string" &&
      issueIdentifier.test(record.identifier) &&
      typeof record.url === "string" &&
      issueUrl.test(record.url)
    ) {
      return { identifier: record.identifier, url: record.url };
    }
    return findIssue(Object.values(record));
  }
  return null;
};

const tool = defineTool({
  description:
    "File one bounded internal Linear ticket for this verified customer investigation. The team, assignee, conversation and workspace scope are taken from the immutable session, never from this input. Use only when a ticket is warranted; provider reads and all other Linear operations remain unavailable.",
  async execute(input, ctx) {
    if (!isFinInvestigation(ctx.session.auth.initiator)) {
      return {
        error:
          "This operation is available only to a verified Fin investigation.",
      };
    }
    try {
      const result = await createFinInvestigationTicket(ctx, input);
      if (!result.ok) {
        return { error: "Linear did not accept the ticket." };
      }
      const issue = findIssue(result.data);
      return (
        issue ?? {
          error:
            "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
        }
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error:
          "The ticket outcome could not be confirmed. Do not retry automatically.",
      };
    }
  },
  inputSchema: z.strictObject({
    summary: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(160),
  }),
  outputSchema: z.union([
    z.object({ identifier: z.string(), url: z.string() }),
    z.object({ error: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? tool : null,
  },
});
