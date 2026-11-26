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

/**
 * A widget ticket's body as the team reads it, with no code block. An opening
 * angle bracket stays literal, so customer text cannot become markup, while a
 * line's `>` still quotes; the server appends the Verified scope block after it.
 */
export const formatCustomerReport = (summary: string) =>
  summary.trim().replaceAll("<", "&lt;");
