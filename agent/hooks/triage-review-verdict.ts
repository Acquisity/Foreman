import { defineHook } from "eve/hooks";
import { resolveModel } from "#lib/models.js";
import { attestTriageReviewVerdict } from "#lib/triage-review-attestation.js";
import { triageCriticVerdictSchema } from "#lib/triage-review-packet.js";
import { readVerifiedTriageReviewPacket } from "#lib/triage-review-packet-file.js";

export default defineHook({
  events: {
    async "subagent.completed"(event, ctx) {
      if (
        event.data.subagentName !== "triage-critic" ||
        event.data.backgroundTask !== undefined
      ) {
        return;
      }
      let output: unknown;
      try {
        output = JSON.parse(event.data.output);
      } catch {
        return;
      }
      const parsed = triageCriticVerdictSchema.safeParse(output);
      if (!parsed.success) {
        return;
      }
      const verdict = parsed.data;
      {
        const verified = await readVerifiedTriageReviewPacket(
          await ctx.getSandbox(),
          verdict.evidence_revision
        );
        if (!verified.verified) {
          return;
        }
        const expectedModel = await resolveModel("triageCritic");
        if (
          verdict.reviewer_model !== verified.packet.criticModel ||
          verdict.reviewer_model !== expectedModel
        ) {
          return;
        }
        await attestTriageReviewVerdict({
          eventId: event.meta.id,
          packet: verified.packet,
          sessionId: ctx.session.id,
          verdict,
        });
      }
    },
  },
});
