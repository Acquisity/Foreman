import { defineTool } from "eve/tools";
import { z } from "zod";
import { AGENT_MODEL_SLOTS, MODELS, readModelOverrides } from "#lib/models.js";

export default defineTool({
  description:
    "Show the global model configuration for Foreman and every specialist: compiled default, live override, and effective model for the next session.",
  execute: async () => {
    const overrides = await readModelOverrides();
    return {
      agents: AGENT_MODEL_SLOTS.map((agent) => ({
        agent,
        default: MODELS[agent],
        effective: overrides[agent] ?? MODELS[agent],
        override: overrides[agent] ?? null,
      })),
    };
  },
  inputSchema: z.object({}),
});
