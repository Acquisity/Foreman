import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import {
  marker,
  matchRun,
  previewBuild,
  requireQa,
  supportClient,
  supportReply,
  WIDGET_ASK,
} from "./helpers.js";

export default defineEval({
  description:
    "W4: two Investigate messages in one widget conversation each complete with a reply, in two separate sessions on the QA build (the PR #233 per-run session rule).",
  tags: ["preview"],
  async test(t) {
    const env = requireQa(t, "QA_ACQUISITY_URL", "QA_ORCA_PAGE");
    const build = await previewBuild(t);
    const support = await supportClient(env.QA_ACQUISITY_URL, env.QA_ORCA_PAGE);
    const sessions: string[] = [];
    for (const ask of [WIDGET_ASK, `Thanks. ${WIDGET_ASK}`]) {
      const tag = marker();
      const since = new Date();
      // biome-ignore lint/performance/noAwaitInLoops: the second message follows the first reply.
      const messageId = await support.send(`${tag} ${ask}`);
      const runId = await matchRun(t, build, "widget", tag, since, 120_000);
      // Watch from the start: a widget session is retired soon after it replies.
      const live = t.target.watchTurn(runId);
      const reply = await supportReply(support, messageId, t.signal);
      await t.require(
        Boolean(reply?.text.trim()),
        satisfies(Boolean, "the investigation replies")
      );
      (await live.result()).succeeded();
      sessions.push(runId);
    }
    await t.require(
      new Set(sessions).size === 2,
      satisfies(Boolean, "each investigation runs in its own session")
    );
  },
  timeoutMs: 1_200_000,
});
