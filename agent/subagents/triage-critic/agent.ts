import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";
import { triageCriticVerdictSchema } from "../../lib/triage-review-packet.js";

export default defineAgent({
  description:
    "Independently challenge a completed customer-bug diagnosis before Foreman performs structural Linear, routing, notification, or investigation-memory writes. Read the immutable packet, verify its repository evidence and optionally search investigation memory, then return APPROVE, CHALLENGE, or INSUFFICIENT_EVIDENCE for that exact evidence revision. Never writes or publishes findings.",
  model: defineDynamic({
    events: {
      "session.started": () => resolveModel("triageCritic"),
    },
  }),
  outputSchema: triageCriticVerdictSchema,
});
