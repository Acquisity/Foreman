import { defineTool } from "eve/tools";
import { z } from "zod";
import { FACTORY_AGENTS, MODELS, readModelOverrides } from "#lib/models.js";

/**
 * Tool that reports which model each factory agent runs on.
 *
 * @remarks
 * Reads the live overrides from Blob and lays them over the compiled defaults, so the answer is
 * what the next session will actually run, not what was deployed. Reading is unrestricted, like
 * `read_factory_brain`: knowing the models is harmless and every caller may ask.
 */
export default defineTool({
  description:
    "Show which model each factory agent (orchestrator and the stations) runs on: the compiled " +
    "default, any live override, and the effective model the next session will use.",
  execute: async () => {
    const overrides = await readModelOverrides();
    return {
      agents: FACTORY_AGENTS.map((agent) => ({
        agent,
        default: MODELS[agent],
        effective: overrides[agent] ?? MODELS[agent],
        override: overrides[agent] ?? null,
      })),
    };
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    agents: z.array(
      z.object({
        agent: z.string(),
        default: z.string(),
        effective: z.string(),
        override: z.string().nullable(),
      })
    ),
  }),
});
