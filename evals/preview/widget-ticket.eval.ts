import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  cancelIssue,
  linear,
  marker,
  matchRun,
  previewBuild,
  requireQa,
  supportClient,
  supportReply,
} from "./helpers.js";

const ISSUE_ID = /[A-Z]+-\d+/u;
const BUG =
  "I want to report a bug. Every time I open the Campaigns page it shows a blank white screen. I have refreshed, cleared my cache, and tried Chrome, Safari and another computer; it still happens. Please file a ticket for the team.";

export default defineEval({
  description:
    "W8: an Investigate bug report files a ticket with widget_file_ticket, the ticket carries the conversation, the customer is told, and the ticket is cancelled after.",
  tags: ["preview"],
  async test(t) {
    const env = requireQa(t, "QA_ACQUISITY_URL", "QA_LINEAR_API_KEY");
    const build = await previewBuild(t);
    const support = await supportClient(env.QA_ACQUISITY_URL);
    const tag = marker();
    const since = new Date();
    const messageId = await support.send(`${tag} ${BUG}`);
    const reply = await supportReply(support, messageId, t.signal);
    // The reply's ticket link lets cleanup run even if a later gate fails.
    let identifier = ISSUE_ID.exec(reply?.ticket?.url ?? "")?.[0];
    try {
      const runId = await matchRun(t, build, "widget", tag, since, 90_000);
      const session = await t.target.attachSession(runId);
      session.succeeded();
      const filed = session.events
        .flatMap((event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "widget_file_ticket"
            ? [(event.data.result.output as { identifier?: string }).identifier]
            : []
        )
        .find(Boolean);
      identifier = filed ?? identifier;
      await t.require(
        Boolean(filed),
        satisfies(Boolean, "widget_file_ticket returned an identifier")
      );
      const { issue } = await linear<{ issue: { description: string } }>(
        "query($id: String!) { issue(id: $id) { description } }",
        { id: filed },
        env.QA_LINEAR_API_KEY
      );
      await t.require(
        issue.description.includes(support.conversationId ?? "-"),
        satisfies(Boolean, "the ticket carries the customer's conversation")
      );
      await t.require(
        Boolean(reply?.ticket || reply?.text.includes(filed ?? "-")),
        satisfies(Boolean, "the customer is told about the ticket")
      );
    } finally {
      if (identifier) {
        await cancelIssue(identifier, env.QA_LINEAR_API_KEY);
      }
    }
  },
  timeoutMs: 1_200_000,
});
