import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "./lib/models.js";
import { ticketLinkedModel } from "./lib/ticket-link-model.js";

// Root agent runtime configuration: the model for Foreman, Acquisity's
// general-purpose agent; the rest of the surface (channels, connections,
// extensions, tools, skills, subagents) is discovered from the filesystem
// under agent/. History compacts at 75% of the context window.
//
// Both per-session token caps are disabled. The input axis would otherwise
// default to 40M tokens, and cached prompt re-reads count as input on every
// model call, so a long Slack thread could cross it and park on eve's
// Approve/Stop budget card, which Slack cannot answer. Output has no cap
// either: a run is billed per session, not per line of output, and the cap
// was blocking legitimate implementation runs.
//
// Wrapped model instances resolve at step start: Eve cannot serialize provider
// objects into durable session/turn selections. resolveModel retains live overrides.
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: { maxInputTokensPerSession: false },
  model: defineDynamic({
    events: {
      "step.started": async () =>
        ticketLinkedModel(await resolveModel("orchestrator")),
    },
  }),
});
