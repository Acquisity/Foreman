import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  linear,
  marker,
  matchRun,
  postSlack,
  previewBuild,
  requireQa,
  settledReplies,
} from "./helpers.js";

const TICKET = process.env.QA_SLACK_TICKET ?? "SAN-81";

export default defineEval({
  description:
    "S1: a Slack mention asks for a Linear ticket's title, a threaded follow-up continues the same session, and the build that answered is the QA branch's.",
  tags: ["preview"],
  async test(t) {
    requireQa(t, "QA_SLACK_TOKEN", "LINEAR_SANDBOX_API_KEY");
    const { issue } = await linear<{ issue: { title: string } }>(
      "query($id: String!) { issue(id: $id) { title } }",
      { id: TICKET }
    );
    const build = await previewBuild(t);
    const tag = marker();
    const since = new Date();
    const thread = await postSlack(
      `${tag} What are the title and status of Linear ticket ${TICKET}? One line.`
    );
    const runId = await matchRun(t, build, "slack", tag, since);
    const session = await t.target.attachSession(runId);
    session.succeeded();
    const firstTurn = session.events.length;

    const title = issue.title.toLowerCase();
    const named = (text = "") => text.toLowerCase().includes(title);
    const replies = await settledReplies(
      thread,
      (reply) => named(reply.text),
      t.signal
    );
    await t.require(
      replies.some((reply) => named(reply.text)),
      satisfies(Boolean, "the Slack reply names the ticket's real title")
    );

    await postSlack(
      `${tag} Thanks. Which team is ${TICKET} in? One line.`,
      thread
    );
    const followUp = await t.target
      .watchTurn(runId, { startIndex: firstTurn })
      .result();
    followUp.succeeded();
    followUp.event("turn.completed", { count: 1 });
    t.notEvent("turn.failed");
  },
  timeoutMs: 900_000,
});
