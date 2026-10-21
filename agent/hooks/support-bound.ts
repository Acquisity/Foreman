/**
 * A hook stops a turn with `ctx.cancel()`; eve logs and swallows an error
 * raised by a hook or a channel handler alike. The counter spans background-result
 * turns without extending the original deadline.
 */
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";
import { logOpsEvent } from "../lib/ops-log.js";
import { isSupportAuth } from "../lib/support/auth.js";
import {
  countSupportStep,
  type SupportRunSteps,
  supportDeadline,
  supportRunBoundReached,
} from "../lib/support/bound.js";

const runSteps = defineState<SupportRunSteps>(
  "foreman.supportRunSteps",
  () => ({
    count: 0,
    stepIndex: -1,
    turnId: null,
  })
);

const stop = (
  ctx: { cancel: () => void; session: { id: string } },
  turnId: string,
  message: string
) => {
  logOpsEvent("support.run_bound", {
    message,
    sessionId: ctx.session.id,
    turnId,
  });
  ctx.cancel();
};

export default defineHook({
  events: {
    "authorization.required": (event, ctx) => {
      if (isSupportAuth(ctx.session.auth.initiator)) {
        stop(
          ctx,
          event.data.turnId,
          "Scheduled support cannot wait for authorization."
        );
      }
    },
    "input.requested": (event, ctx) => {
      if (isSupportAuth(ctx.session.auth.initiator)) {
        stop(
          ctx,
          event.data.turnId,
          "Scheduled support cannot wait for human input."
        );
      }
    },
    "step.started": (event, ctx) => {
      const auth = ctx.session.auth.initiator;
      if (!isSupportAuth(auth) || ctx.session.parent) {
        return;
      }
      const steps = countSupportStep(runSteps.get(), event.data);
      if (
        supportRunBoundReached({
          deadline: supportDeadline(auth),
          now: Date.now(),
          steps: steps.count,
        })
      ) {
        stop(
          ctx,
          event.data.turnId,
          "Support investigation reached its run bound."
        );
        return;
      }
      runSteps.update(() => steps);
    },
  },
});
