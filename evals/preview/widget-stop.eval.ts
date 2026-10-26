import { setTimeout as sleep } from "node:timers/promises";
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
    "W7: Stop during an investigation cancels its turn, no stale reply arrives for it, and the next message is answered.",
  tags: ["preview"],
  async test(t) {
    const env = requireQa(t, "QA_ACQUISITY_URL", "QA_ORCA_PAGE");
    const build = await previewBuild(t);
    const support = await supportClient(env.QA_ACQUISITY_URL, env.QA_ORCA_PAGE);
    const tag = marker();
    const since = new Date();
    const stoppedId = await support.send(`${tag} ${WIDGET_ASK}`);
    const runId = await matchRun(t, build, "widget", tag, since, 120_000);
    // Watch from the start: a widget session is retired soon after it settles.
    const live = t.target.watchTurn(runId);
    await sleep(Math.max(0, since.getTime() + 15_000 - Date.now()), undefined, {
      signal: t.signal,
    });
    await t.require(
      await support.stop(),
      satisfies(Boolean, "the app accepts Stop")
    );
    (await live.result()).event("turn.cancelled", { count: 1 });

    await sleep(60_000, undefined, { signal: t.signal });
    const messages = await support.get();
    const index = messages.findIndex((message) => message.id === stoppedId);
    await t.require(
      !messages
        .slice(index + 1)
        .some((message) => message.authorKind === "foreman"),
      satisfies(Boolean, "no reply arrives for the stopped run within 60 s")
    );

    const next = await support.send(`${marker()} ${WIDGET_ASK}`);
    const reply = await supportReply(support, next, t.signal);
    await t.require(
      Boolean(reply?.text.trim()),
      satisfies(Boolean, "the next message is answered")
    );
  },
  timeoutMs: 1_200_000,
});
