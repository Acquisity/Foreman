import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { createFinInvestigationTicket } from "#lib/executor/dispatch.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";
import { providerData } from "#lib/support/conversation.js";

const issueUrl =
  /^https:\/\/linear\.app\/acquisity\/issue\/(ENG-\d+)(?:\/[^\s?#]*)?(?:[?#][^\s]*)?$/u;
const issueIdentifier = /^ENG-\d+$/u;
const writtenIssue = z
  .object({
    id: z.string().regex(issueIdentifier),
    url: z.string().regex(issueUrl),
  })
  .transform((issue, ctx) => {
    if (issueUrl.exec(issue.url)?.[1] !== issue.id) {
      ctx.addIssue({ code: "custom", message: "Issue URL does not match." });
      return z.NEVER;
    }
    return { identifier: issue.id, url: issue.url };
  });

export const confirmedFinIssue = (data: unknown) =>
  writtenIssue.parse(providerData(data));

export const formatFinCustomerReport = (summary: string) => {
  const longestRun = Math.max(
    0,
    ...Array.from(summary.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `## Customer report\n\n${fence}text\n${summary}\n${fence}`;
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
      const result = await createFinInvestigationTicket(ctx, {
        report: formatFinCustomerReport(input.summary),
        title: input.title,
      });
      if (!result.ok) {
        return { error: "Linear did not accept the ticket." };
      }
      try {
        return confirmedFinIssue(result.data);
      } catch {
        return {
          error:
            "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
        };
      }
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
