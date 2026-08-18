import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "./lib/models.js";
import { isSlackSession } from "./lib/prompts.js";

// Root agent runtime configuration: the model for Foreman, the software factory
// orchestrator; the rest of the surface (channels, connections, extensions, tools,
// skills, subagents) is discovered from the filesystem under agent/. History compacts at
// 75% of the context window, and there is no per-session output cap: a run is billed per
// session, not per line of output, and the cap was blocking legitimate implementation runs.
//
// The model resolves at session start through resolveModel, so a live override saved with
// set_factory_models applies to the next session without a redeploy; without one, the compiled
// default from MODELS runs. Sessions born on the Slack channel resolve the chat slot instead of
// orchestrator: Slack traffic is mostly conversational, its replies land only when the turn
// completes, and the paired chat instructions profile carries no inline pipeline, so a faster
// model there shortens every reply without touching factory intake.
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) =>
        resolveModel(isSlackSession(ctx) ? "chat" : "orchestrator"),
    },
  }),
});
