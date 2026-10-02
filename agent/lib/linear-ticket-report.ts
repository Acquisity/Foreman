import { z } from "zod";
import { providerData } from "./support/conversation.js";

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

export const confirmedIssue = (data: unknown) =>
  writtenIssue.parse(providerData(data));

export const formatCustomerReport = (summary: string) => {
  const longestRun = Math.max(
    0,
    ...Array.from(summary.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `## Customer report\n\n${fence}text\n${summary}\n${fence}`;
};
