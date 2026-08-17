import { defineTool } from "eve/tools";
import { z } from "zod";
import { modelSwapPolicy } from "#lib/github/approval.js";
import {
  FACTORY_AGENTS,
  isValidModelId,
  listGatewayModels,
  loadModelOverrides,
  MODELS,
  writeModelOverrides,
} from "#lib/models.js";

/**
 * Tool that swaps the model a factory agent runs on, live, without a redeploy.
 *
 * @remarks
 * Writes the override document every session's model resolver reads at start, so a swap applies
 * to sessions that begin after it; running sessions keep their model. Gated by
 * `modelSwapPolicy`: this is shared configuration every future run inherits, so unattended runs
 * are denied (a labeled issue's body must not be able to repoint the factory's models), trusted
 * callers swap directly, and everyone else parks on approval.
 *
 * Two write-safety rules, both because a bad override outlives redeploys and a bad orchestrator
 * override would fail every future session before any tool could undo it: every new id must
 * exist in the live gateway catalog (not just match the id shape), and the merge base is the
 * strict `loadModelOverrides` read, so a transient Blob failure surfaces as an error instead of
 * silently wiping overrides this call never named.
 */
export default defineTool({
  approval: modelSwapPolicy,
  description:
    "Swap the model one or more factory agents run on, live. Pass a Vercel AI Gateway id " +
    "(provider/model, e.g. zai/glm-5.2) per agent to override it, or null to clear an override " +
    "back to the compiled default. Ids are verified against the live gateway catalog before " +
    "anything is stored. Takes effect on sessions that start after the change; the current " +
    "session keeps its model.",
  execute: async (input) => {
    let overrides: Awaited<ReturnType<typeof loadModelOverrides>>;
    try {
      overrides = { ...(await loadModelOverrides()) };
    } catch (error) {
      return {
        error: `Could not read the current overrides, so nothing was changed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        success: false as const,
      };
    }
    const requested = FACTORY_AGENTS.flatMap((agent) => {
      const value = input[agent];
      return typeof value === "string" ? [{ agent, id: value }] : [];
    });
    for (const { id } of requested) {
      if (!isValidModelId(id)) {
        return {
          error: `'${id}' is not a valid gateway model id (expected provider/model).`,
          success: false as const,
        };
      }
    }
    if (requested.length > 0) {
      let known: Set<string>;
      try {
        known = new Set((await listGatewayModels()).map((model) => model.id));
      } catch {
        return {
          error:
            "Could not reach the gateway catalog to verify the model ids, so nothing was changed.",
          success: false as const,
        };
      }
      const unknown = requested.filter(({ id }) => !known.has(id));
      if (unknown.length > 0) {
        return {
          error: `Not in the gateway catalog: ${unknown
            .map(({ id }) => `'${id}'`)
            .join(", ")}. Nothing was changed.`,
          success: false as const,
        };
      }
    }
    for (const agent of FACTORY_AGENTS) {
      const value = input[agent];
      if (value === null) {
        delete overrides[agent];
      } else if (typeof value === "string") {
        overrides[agent] = value;
      }
    }
    try {
      await writeModelOverrides(overrides);
    } catch (error) {
      return {
        error: `Could not save the overrides, so nothing was changed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        success: false as const,
      };
    }
    return {
      effective: Object.fromEntries(
        FACTORY_AGENTS.map((agent) => [
          agent,
          overrides[agent] ?? MODELS[agent],
        ])
      ),
      success: true as const,
    };
  },
  inputSchema: z.object(
    Object.fromEntries(
      FACTORY_AGENTS.map((agent) => [
        agent,
        z
          .string()
          .nullable()
          .optional()
          .describe(
            `Gateway model id for the ${agent}, or null to restore its default.`
          ),
      ])
    )
  ),
  outputSchema: z.object({
    effective: z.record(z.string(), z.string()).optional(),
    error: z.string().optional(),
    success: z.boolean(),
  }),
});
