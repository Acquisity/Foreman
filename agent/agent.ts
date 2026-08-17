import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "./lib/models.js";
import { isSlackSession } from "./lib/prompts.js";

/**
 * Root agent runtime configuration.
 *
 * @remarks
 * Sets the model and the session budget for Foreman, the software factory
 * orchestrator; the rest of the agent's surface (channels, connections,
 * extensions, tools, skills, subagents) is discovered from the filesystem
 * under `agent/`. Conversation history is compacted once it reaches 75% of
 * the context window. The per-session output token limit caps runaway
 * sessions while leaving room for the pipeline: the four stations draw from
 * the root session's remaining quota, and an implementation run needs far
 * more than a chat reply.
 *
 * The model resolves at session start through `resolveModel`, so a live
 * override saved with `set_factory_models` applies to the next session
 * without a redeploy; without one, the compiled default from `MODELS` runs.
 * Sessions born on the Slack channel resolve the `chat` slot instead of
 * `orchestrator`: Slack traffic is mostly conversational, its replies land
 * only when the turn completes, and the paired chat instructions profile
 * carries no inline pipeline, so a faster model there shortens every reply
 * without touching factory intake.
 */
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: {
    maxOutputTokensPerSession: 100_000,
  },
  model: defineDynamic({
    events: {
      "session.started": (_event, ctx) =>
        resolveModel(isSlackSession(ctx) ? "chat" : "orchestrator"),
    },
  }),
});
