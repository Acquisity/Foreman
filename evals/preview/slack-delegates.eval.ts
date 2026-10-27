import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  COMPUTATIONS,
  DELEGATION_ASK,
  finalText,
  marker,
  matchRun,
  postSlack,
  previewBuild,
  requireQa,
  settledReplies,
} from "./helpers.js";

export default defineEval({
  description:
    "S4: a Slack mention runs two native delegates, waits for both, and posts both results in exactly one reply.",
  tags: ["preview"],
  async test(t) {
    requireQa(t, "QA_SLACK_TOKEN");
    const build = await previewBuild(t);
    const tag = marker();
    const since = new Date();
    const thread = await postSlack(`${tag} ${DELEGATION_ASK}`);
    const runId = await matchRun(t, build, "slack", tag, since);
    const session = await t.target.attachSession(runId);
    session.succeeded();
    session.calledSubagent("agent", { count: 2, status: "completed" });
    session.calledTool("eve__task_wait");
    session.notCalledTool("sleep");
    await t.require(
      COMPUTATIONS.every(({ line }) =>
        finalText(session.events).includes(line)
      ) && !JSON.stringify(session.events).includes("<eve-empty-delivery/>"),
      satisfies(Boolean, "the final message carries both results")
    );

    const both = (text = "") =>
      COMPUTATIONS.every(({ line }) => text.includes(line));
    const either = (text = "") =>
      COMPUTATIONS.some(({ line }) => text.includes(line));
    const replies = await settledReplies(
      thread,
      (reply) => both(reply.text),
      t.signal
    );
    await t.require(
      replies.filter((reply) => either(reply.text)).length === 1 &&
        replies.some((reply) => both(reply.text)),
      satisfies(Boolean, "exactly one Slack reply carries both results")
    );
  },
  timeoutMs: 900_000,
});
