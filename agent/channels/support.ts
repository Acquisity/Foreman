import { defineChannel } from "eve/channels";
import {
  claimFromContext,
  isSupportAuth,
  supportClaim,
} from "../lib/support/auth.js";
import { reportSupportFailureForClaim } from "../lib/support/investigation.js";
import {
  findSupportLease,
  requireSupportLease,
  settleSupport,
} from "../lib/support/store.js";

/** Internal schedule handoff only. No public route and no automatic Slack delivery. */
export default defineChannel({
  context: (state) => ({ state }),
  events: {
    "actions.requested"(_event, channel) {
      channel.state.actions += 1;
      if (channel.state.actions > 150 || Date.now() >= channel.state.deadline) {
        throw new Error("Support investigation reached its run bound.");
      }
    },
    "reasoning.appended"(_event, channel) {
      if (Date.now() >= channel.state.deadline) {
        throw new Error("Support investigation reached its run bound.");
      }
    },
    async "turn.completed"(_event, _channel, ctx) {
      const claim = claimFromContext(ctx);
      // Completion is not evidence of an infrastructure failure. Retry unfinished work quietly.
      // Pending outboxes retain their lease and marker for delivery reconciliation.
      if (claim) {
        await findSupportLease(claim)
          .then((row) =>
            row && !row.report ? settleSupport(claim) : undefined
          )
          .catch(() => undefined);
      }
    },
    async "turn.failed"(_event, _channel, ctx) {
      const claim = claimFromContext(ctx);
      if (claim) {
        await findSupportLease(claim)
          .then((row) =>
            row ? reportSupportFailureForClaim(claim) : undefined
          )
          .catch(() => undefined);
      }
    },
  },
  async receive(input, { from }) {
    if (!isSupportAuth(input.auth)) {
      throw new Error("Scheduled support identity required.");
    }
    const claim = supportClaim.parse(input.auth?.attributes);
    await requireSupportLease(claim);
    return from(`${claim.conversation}:${claim.thread}:${claim.lease}`).send(
      input.message,
      {
        auth: input.auth,
        mode: "task",
        state: { actions: 0, deadline: Date.now() + 18 * 60_000 },
        turnPolicy: "queue",
      }
    );
  },
  routes: [],
  state: { actions: 0, deadline: 0 },
});
