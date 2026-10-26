import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  marker,
  matchRun,
  previewBuild,
  requireQa,
  supportClient,
  supportReply,
} from "./helpers.js";

const BUG =
  "I want to report a bug. Every time I open the Campaigns page it shows a blank white screen. I have refreshed, cleared my cache, and tried Chrome, Safari and another computer; it still happens. Please file a ticket for the team.";

export default defineEval({
  description:
    "W8: an Investigate bug report files a ticket with widget_file_ticket and the customer is told. The ENG ticket is logged for manual cancellation.",
  tags: ["preview"],
  async test(t) {
    const env = requireQa(t, "QA_ACQUISITY_URL");
    const build = await previewBuild(t);
    const support = await supportClient(env.QA_ACQUISITY_URL);
    const tag = marker();
    const since = new Date();
    const messageId = await support.send(`${tag} ${BUG}`);
    const reply = await supportReply(support, messageId, t.signal);
    if (reply?.ticket) {
      t.log(`filed ticket ${reply.ticket.url}: cancel it with a comment`);
    }
    const runId = await matchRun(t, build, "widget", tag, since, 90_000);
    const session = await t.target.attachSession(runId);
    session.succeeded();
    const identifier = session.events
      .flatMap((event) =>
        event.type === "action.result" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "widget_file_ticket"
          ? [(event.data.result.output as { identifier?: string }).identifier]
          : []
      )
      .find(Boolean);
    t.log(`widget_file_ticket returned ${identifier ?? "no identifier"}`);
    await t.require(
      Boolean(identifier),
      satisfies(Boolean, "widget_file_ticket returned an identifier")
    );
    await t.require(
      Boolean(reply?.ticket || reply?.text.includes(identifier ?? "-")),
      satisfies(Boolean, "the customer is told about the ticket")
    );
  },
  timeoutMs: 1_200_000,
});
