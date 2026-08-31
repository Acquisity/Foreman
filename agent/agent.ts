import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "./lib/models.js";

// Root agent runtime configuration: the model for Foreman, Acquisity's
// general-purpose agent; the rest of the surface (channels, connections,
// extensions, tools, skills, subagents) is discovered from the filesystem
// under agent/. History compacts at 50% of the context window. Eve adds the
// system instructions and tool schemas after compaction, so the remaining
// half reserves headroom for that envelope instead of filling the model window
// with compacted history alone.
//
// Both per-session token caps are disabled. The input axis would otherwise
// default to 40M tokens, and cached prompt re-reads count as input on every
// model call, so a long Slack thread could cross it and park on eve's
// Approve/Stop budget card, which Slack cannot answer. Output has no cap
// either: a run is billed per session, not per line of output, and the cap
// was blocking legitimate implementation runs.
//
// The model resolves at session start through resolveModel, so a live override saved with
// set_agent_models applies to the next session without a redeploy; without one, the compiled
// default from MODELS runs.
export default defineAgent({
  compaction: { thresholdPercent: 0.5 },
  limits: { maxInputTokensPerSession: false },
  model: defineDynamic({
    events: {
      "session.started": () => resolveModel("orchestrator"),
    },
  }),
});
