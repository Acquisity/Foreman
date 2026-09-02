import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool } from "eve/tools";
import { z } from "zod";

// Resolving a dynamic tool evaluates every authored module through eve's
// bundled module map, and prompts.ts reads both connector variables at module
// load (constants.ts). Nothing is contacted; `pnpm validate` runs `eve info`
// under the same environment.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";
process.env.PLANETSCALE_MCP_CONNECTOR =
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const { admitDynamicTools, dynamicToolCacheKey } = await import(
  "./eve-dynamic-tools.js"
);
const { laneAuth } = await import("./capability-budget.js");

const NOTHING_ADMITTED = /eve admitted 0 of the 1 tools 'crm'/u;

// The repository root, so a fixture's dynamic tool resolves through the same
// bundled module map the repository's own manifest does.
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OTHER_APP_ROOT = `${APP_ROOT}other`;

const ENTRY = {
  eventNames: ["step.started"],
  extensionNamespace: "github",
  logicalPath: "extensions/github/tools/github.ts",
  slug: "github__github",
  sourceId: "ext-override:github:tools/github.ts",
  sourceKind: "module" as const,
};

const session = (lane: "slack" | "autonomous-factory") => ({
  auth: laneAuth(lane),
  id: `capability-budget:${lane}`,
});

describe("eve dynamic tool adapter", () => {
  it("refuses to count a dynamic tool map eve would drop", async () => {
    // eve stamps a durable descriptor on a callback only when it bundles the
    // authored module, so every callback in this test process is bare, the
    // way a policy handed to the GitHub extension's `overrides` from anywhere
    // but durable-callbacks.ts is in a deployment. eve's own dispatch rejects
    // the entry, drops the resolver's whole result, and the measurement must
    // fail rather than count the tool as model-visible.
    const resolver = {
      eventNames: ["step.started"],
      events: {
        "step.started": () => ({
          lookup: defineTool({
            description: "Look a record up.",
            execute: () => null,
            inputSchema: z.object({ id: z.string() }),
          }),
        }),
      },
      extensionNamespace: "crm",
      logicalPath: "../node_modules/crm/tools/crm.mjs",
      slug: "crm",
      sourceId: "ext:crm:tools/crm.mjs",
      sourceKind: "module" as const,
    };
    await assert.rejects(
      admitDynamicTools(resolver, session("slack")),
      NOTHING_ADMITTED
    );
  });

  it("keys dynamic tools by session and complete entry identity", () => {
    const slack = dynamicToolCacheKey(ENTRY, APP_ROOT, session("slack").id);
    assert.notEqual(
      slack,
      dynamicToolCacheKey(ENTRY, APP_ROOT, session("autonomous-factory").id)
    );
    assert.notEqual(
      slack,
      dynamicToolCacheKey(ENTRY, OTHER_APP_ROOT, session("slack").id)
    );
    assert.notEqual(
      slack,
      dynamicToolCacheKey(
        { ...ENTRY, exportName: "other" },
        APP_ROOT,
        session("slack").id
      )
    );
    assert.notEqual(
      slack,
      dynamicToolCacheKey(
        { ...ENTRY, extensionNamespace: "other" },
        APP_ROOT,
        session("slack").id
      )
    );
  });
});
