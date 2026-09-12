import { defineChannel, GET } from "eve/channels";
import {
  isSupportAuth,
  type SupportClaim,
  supportClaim,
} from "../lib/support/auth.js";
import { reportSupportFailureForClaim } from "../lib/support/investigation.js";
import { requireSupportLease } from "../lib/support/store.js";

async function reportFailure(claim: SupportClaim | null) {
  if (!claim) {
    return;
  }
  try {
    await reportSupportFailureForClaim(claim);
  } catch {
    // Stale leases and pending or uncertain outboxes stay with the next check.
  }
}

/**
 * Internal schedule handoff only. HTTP requests cannot start sessions. The
 * run bound lives in agent/hooks/support-bound.ts: eve swallows an error
 * thrown by a channel event handler, while a thrown hook fails the turn.
 */
export default defineChannel({
  context: (state) => ({ state }),
  events: {
    async "session.failed"(_event, channel) {
      // This event has no session context. Only the root receive seeds a claim.
      await reportFailure(channel.state.claim);
    },
    async "turn.failed"(_event, channel, ctx) {
      if (!ctx.session.parent) {
        await reportFailure(channel.state.claim);
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
        mode: "conversation",
        state: { claim },
        turnPolicy: "queue",
      }
    );
  },
  // Eve registers channels by route and matches bundled imports by route shape.
  // A route-less channel disappears from the runtime, including schedule targets.
  routes: [
    GET("/internal/support", () =>
      Promise.resolve(new Response(null, { status: 404 }))
    ),
  ],
  state: { claim: null as SupportClaim | null },
});
