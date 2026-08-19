import { defineTool } from "eve/tools";
import { z } from "zod";
import { modelSwapPolicy } from "#lib/github/approval.js";
import {
  AGENT_MODEL_SLOTS,
  isValidModelId,
  listGatewayModels,
  loadModelOverrides,
  MODELS,
  type ModelOverrides,
  writeModelOverrides,
} from "#lib/models.js";

export default defineTool({
  approval: modelSwapPolicy,
  description:
    "Set global live model overrides for Foreman and its specialists. Pass a verified provider/model id or null to restore the compiled default. Changes apply to new sessions.",
  execute: async (input) => {
    let overrides: ModelOverrides;
    try {
      overrides = { ...(await loadModelOverrides()) };
    } catch (error) {
      return {
        error: `Could not read current overrides: ${error instanceof Error ? error.message : "unknown error"}`,
        success: false as const,
      };
    }
    const requested = AGENT_MODEL_SLOTS.flatMap((agent) => {
      const value = input[agent];
      return typeof value === "string" ? [{ agent, id: value }] : [];
    });
    if (requested.some(({ id }) => !isValidModelId(id))) {
      return {
        error: "Every override must be a valid provider/model gateway id.",
        success: false as const,
      };
    }
    if (requested.length > 0) {
      let known: Set<string>;
      try {
        known = new Set((await listGatewayModels()).map(({ id }) => id));
      } catch {
        return {
          error: "Could not verify model ids against the gateway catalog.",
          success: false as const,
        };
      }
      const unknown = requested.filter(({ id }) => !known.has(id));
      if (unknown.length > 0) {
        return {
          error: `Not in the gateway catalog: ${unknown.map(({ id }) => id).join(", ")}.`,
          success: false as const,
        };
      }
    }
    for (const agent of AGENT_MODEL_SLOTS) {
      const value = input[agent];
      if (value === null) {
        delete overrides[agent];
      } else if (typeof value === "string") {
        overrides[agent] = value;
      }
    }
    try {
      await writeModelOverrides(overrides);
      return {
        effective: Object.fromEntries(
          AGENT_MODEL_SLOTS.map((agent) => [
            agent,
            overrides[agent] ?? MODELS[agent],
          ])
        ),
        success: true as const,
      };
    } catch (error) {
      return {
        error: `Could not save overrides: ${error instanceof Error ? error.message : "unknown error"}`,
        success: false as const,
      };
    }
  },
  inputSchema: z.object(
    Object.fromEntries(
      AGENT_MODEL_SLOTS.map((agent) => [
        agent,
        z.string().nullable().optional(),
      ])
    )
  ),
});
