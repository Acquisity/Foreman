/**
 * A thrown authored hook fails the turn; a channel handler cannot enforce this
 * bound because eve swallows its errors. The counter spans background-result
 * turns without extending the original deadline.
 */
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";
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

export default defineHook({
  events: {
    "authorization.required": (_event, ctx) => {
      if (isSupportAuth(ctx.session.auth.initiator)) {
        throw new Error("Scheduled support cannot wait for authorization.");
      }
    },
    "input.requested": (_event, ctx) => {
      if (isSupportAuth(ctx.session.auth.initiator)) {
        throw new Error("Scheduled support cannot wait for human input.");
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
        throw new Error("Support investigation reached its run bound.");
      }
      runSteps.update(() => steps);
    },
  },
});
