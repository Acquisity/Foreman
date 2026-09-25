import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { replyToRequester } from "#lib/requester-reply.js";

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Reply to the requester in the Slack thread behind an intake ticket, as Acquisity Foreman. Use it only in a Linear session; in a Slack conversation, answer in the thread directly instead. Post exactly one message: your answer, or your questions when you need more from them. " +
    "It refuses a second post until the requester replies, and fails when the issue has no Slack thread. Never put the investigation itself here; that belongs in the document.",
  async execute({ issue, message }, ctx) {
    try {
      const reply = await replyToRequester(
        issue,
        message,
        (await ctx.getToken(linearAuth)).token
      );
      return { posted: true as const, ...reply };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error: error instanceof Error ? error.message : "Reply failed.",
        posted: false as const,
      };
    }
  },
  inputSchema: z.object({
    issue: z
      .string()
      .trim()
      .regex(LINEAR_ISSUE_ID_PATTERN)
      .describe("The intake ticket, such as ENG-123."),
    message: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("The one requester-facing message, in plain words."),
  }),
});
