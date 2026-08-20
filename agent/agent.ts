import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "./lib/models.js";

// Root agent runtime configuration: the model for Foreman, the software factory
// orchestrator; the rest of the surface (channels, connections, extensions, tools,
// skills, subagents) is discovered from the filesystem under agent/. History compacts at
// 75% of the context window, and there is no per-session output cap: a run is billed per
// session, not per line of output, and the cap was blocking legitimate implementation runs.
//
// The model resolves at session start through resolveModel, so a live override saved with
// set_agent_models applies to the next session without a redeploy; without one, the compiled
// default from MODELS runs.
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  model: defineDynamic({
    events: {
      "session.started": (_event, _ctx) => resolveModel("orchestrator"),
    },
  }),
});
