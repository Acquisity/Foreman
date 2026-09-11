/**
 * Run bound for the scheduled Intercom support root. eve catches and logs
 * every error a channel adapter event handler throws ("adapter event handler
 * threw — event swallowed"), so the bound cannot live in
 * `agent/channels/support.ts`. A thrown authored hook is not caught: it
 * surfaces as `turn.failed`, which the support channel already turns into
 * the failure status and lease release. No state, no logging.
 */
import { defineHook } from "eve/hooks";
import { isSupportAuth } from "../lib/support/auth.js";
import {
  supportDeadline,
  supportRunBoundReached,
} from "../lib/support/bound.js";

export default defineHook({
  events: {
    "step.started": (event, ctx) => {
      const auth = ctx.session.auth.initiator;
      if (!isSupportAuth(auth) || ctx.session.parent) {
        return;
      }
      if (
        supportRunBoundReached({
          deadline: supportDeadline(auth),
          now: Date.now(),
          stepIndex: event.data.stepIndex,
        })
      ) {
        throw new Error("Support investigation reached its run bound.");
      }
    },
  },
});
