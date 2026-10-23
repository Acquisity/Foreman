import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { questionsOnlyPolicy } from "#lib/github/approval.js";
import { rewriteDraft } from "#lib/intake-writer.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { replyToRequester } from "#lib/requester-reply.js";
import { recordReplayReply } from "#lib/triage-replay/client.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { isTriageIntake } from "#lib/trust.js";

const MESSAGE_MAX_CHARS = 4000;

export default defineTool({
  approval: questionsOnlyPolicy,
  description:
    "Reply to the requester in the thread behind an intake ticket (a Slack thread, or the support team's notes on an Acquisity inbox conversation), as Acquisity Foreman. Use it only in a Linear session; in a Slack conversation, answer in the thread directly instead. Post exactly one message: your answer. " +
    "It refuses a second post until the requester replies, and fails when the issue has no requester thread. On a follow-up, Jev decides whether their reply needs an answer; posted false with an outcome means it posted nothing, so follow its reason and do not post the message anywhere else. Never put the investigation itself here; that belongs in the document.",
  async execute({ issue, message }, ctx) {
    if (replaySessionOf(ctx.session.auth.initiator)) {
      return await recordReplayReply(
        ctx.session.auth.initiator,
        issue,
        message
      );
    }
    try {
      return await replyToRequester(
        issue,
        message,
        (await ctx.getToken(linearAuth)).token,
        ctx.abortSignal,
        isTriageIntake(ctx.session.auth.initiator ?? null)
          ? (draft) => rewriteDraft(draft, MESSAGE_MAX_CHARS, ctx.abortSignal)
          : undefined
      );
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
      .max(MESSAGE_MAX_CHARS)
      .describe("The one requester-facing message, in plain words."),
  }),
});
