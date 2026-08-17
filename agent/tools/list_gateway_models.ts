import { defineTool } from "eve/tools";
import { z } from "zod";
import { listGatewayModels } from "#lib/models.js";

const MAX_RESULTS = 200;

/**
 * Tool that lists the models available on the Vercel AI Gateway.
 *
 * @remarks
 * This is the lookup step before `set_factory_models`: it turns a person's loose model name
 * ("glm 5.2") into the exact gateway id (`zai/glm-5.2`). Read-only, so it needs no approval
 * gate. Goes through the gateway provider from the `ai` SDK, which authenticates the same way
 * eve's own model calls do, instead of hand-rolling credential resolution.
 */
export default defineTool({
  description:
    "List models available on the Vercel AI Gateway, as provider/model ids. Pass a search " +
    "term to filter (matched case-insensitively against id and name). Use it to resolve a " +
    "person's model name to the exact gateway id before calling set_factory_models.",
  execute: async ({ search }) => {
    let all: Awaited<ReturnType<typeof listGatewayModels>>;
    try {
      all = await listGatewayModels();
    } catch (error) {
      return {
        error: `Gateway catalog request failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        models: [],
        success: false as const,
      };
    }
    const needle = search?.toLowerCase() ?? "";
    const models = all
      .filter(
        (model) =>
          needle === "" ||
          model.id.toLowerCase().includes(needle) ||
          model.name.toLowerCase().includes(needle)
      )
      .slice(0, MAX_RESULTS);
    return { models, success: true as const };
  },
  inputSchema: z.object({
    search: z
      .string()
      .max(100)
      .optional()
      .describe("Case-insensitive filter on model id or name."),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
    success: z.boolean(),
  }),
});
