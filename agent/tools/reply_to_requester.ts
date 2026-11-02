import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { questionsOnlyPolicy } from "#lib/github/approval.js";
import { rewriteDraft } from "#lib/intake-writer.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { replyToRequester } from "#lib/requester-reply.js";
import { replayReply } from "#lib/triage-replay/client.js";
import { isTriageIntake } from "#lib/trust.js";

const MESSAGE_MAX_CHARS = 4000;

export default defineTool({
  approval: questionsOnlyPolicy,
  description:
    "Reply to the requester in the thread behind an intake ticket (a Slack thread, or the support team's notes on an Acquisity inbox conversation), as Acquisity Foreman. Use it only in a Linear session; in a Slack conversation, answer in the thread directly instead. Post exactly one message: your answer. " +
    "It posts nothing while Foreman's answer is still the newest message in the thread (outcome already_replied: the requester has it), and fails when the issue has no requester thread. On a follow-up, Jev decides whether their reply needs an answer; posted false with an outcome means it posted nothing, so follow its reason and do not post the message anywhere else. A post counts as the requester told about the current triage decision, which route_ticket needs before a User Error or Platform Limitation closes; already_replied or skip counts only when that answer was posted after the decision, so a corrected decision needs its own reply. Never put the investigation itself here; that belongs in the document.",
  async execute({ issue, message }, ctx) {
    const replayed = replayReply(ctx.session.auth.initiator, issue);
    if (replayed) {
      return { ...replayed, issue };
    }
    try {
      const result = await replyToRequester(
        issue,
        message,
        (await ctx.getToken(linearAuth)).token,
        ctx.abortSignal,
        isTriageIntake(ctx.session.auth.initiator ?? null)
          ? (draft) => rewriteDraft(draft, MESSAGE_MAX_CHARS, ctx.abortSignal)
          : undefined
      );
      // The issue rides on the result so the ops hook can record that this
      // requester was told, which route_ticket needs before an explanation closes.
      return { ...result, issue };
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
