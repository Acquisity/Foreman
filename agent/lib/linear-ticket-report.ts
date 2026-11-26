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

const FENCE_CHARACTER = /[\\`~]/gu;
const INDENT = /^[ \t]+/gmu;

/**
 * A widget ticket's body as the team reads it, with no code block. Backslashes,
 * backticks and tildes are escaped and line indents dropped, so no text inside can open
 * a code block that would swallow what follows, and an opening angle bracket
 * stays literal, so it cannot become markup. A line's `>` still quotes.
 */
export const formatCustomerReport = (summary: string) =>
  summary
    .trim()
    .replaceAll(INDENT, "")
    .replaceAll("<", "&lt;")
    .replaceAll(FENCE_CHARACTER, (character) => `\\${character}`);
