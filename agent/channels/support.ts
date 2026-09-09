import { defineChannel, GET } from "eve/channels";
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

/** Internal schedule handoff only. HTTP requests cannot start sessions. */
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
      // An unfinished initial intake still needs a short Slack status; later follow-ups stay quiet.
      // Pending outboxes retain their lease and marker for delivery reconciliation.
      if (claim) {
        await findSupportLease(claim)
          .then(async (row) => {
            if (!row || row.report) {
              return;
            }
            await (row.processed_version
              ? settleSupport(claim)
              : reportSupportFailureForClaim(claim));
          })
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
  // Eve 0.44 registers channels by route and matches bundled imports by route shape.
  // A route-less channel disappears from the runtime, including schedule targets.
  routes: [
    GET("/internal/support", () =>
      Promise.resolve(new Response(null, { status: 404 }))
    ),
  ],
  state: { actions: 0, deadline: 0 },
});
