import { defineTool } from "eve/tools";
import { z } from "zod";
import { modelSwapPolicy } from "#lib/github/approval.js";
import {
  AGENT_MODEL_SLOTS,
  isValidModelId,
  listGatewayModels,
  listProxyModels,
  loadModelOverrides,
  MODELS,
  type ModelOverrides,
  proxyModelName,
  writeModelOverrides,
} from "#lib/models.js";

export default defineTool({
  approval: modelSwapPolicy,
  description:
    "Set global live model overrides for Foreman and its specialists. Pass a verified provider/model id or null to restore the compiled default. Changes apply to new sessions and may take up to 15 seconds to reach every warm instance.",
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
        error: "Every override must be a valid provider/model id.",
        success: false as const,
      };
    }
    const catalogs = [
      {
        ids: requested.filter(({ id }) => id.startsWith("anthropic/")),
        label: "CLI Proxy",
        modelName: proxyModelName,
        read: listProxyModels,
      },
      {
        ids: requested.filter(({ id }) => !id.startsWith("anthropic/")),
        label: "gateway",
        modelName: (id: string) => id,
        read: async () =>
          new Set((await listGatewayModels()).map(({ id }) => id)),
      },
    ];
    for (const catalog of catalogs) {
      if (catalog.ids.length === 0) {
        continue;
      }
      let known: Set<string>;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Refuse before reading the next catalog when validation fails.
        known = await catalog.read();
      } catch {
        return {
          error: `Could not verify model ids against the ${catalog.label} catalog.`,
          success: false as const,
        };
      }
      const unknown = catalog.ids.filter(
        ({ id }) => !known.has(catalog.modelName(id))
      );
      if (unknown.length > 0) {
        return {
          error: `Not in the ${catalog.label} catalog: ${unknown.map(({ id }) => id).join(", ")}.`,
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
        error: `Could not save overrides; no changes were made: ${error instanceof Error ? error.message : "unknown error"}`,
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
