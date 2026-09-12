import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { GITHUB_TOOL_ALLOWLIST } from "./github/tool-allowlist.js";

// Resolving a dynamic tool evaluates every authored module through eve's
// bundled module map, and prompts.ts reads the Linear connector variable at module
// load (constants.ts). Nothing is contacted; `pnpm validate` runs `eve info`
// under the same environment.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const {
  admitDynamicTools,
  dynamicToolCacheKey,
  loadCompiledDynamicToolResolvers,
} = await import("./eve-dynamic-tools.js");
const { laneAuth, readCompiledManifest, COMPILED_MANIFEST_PATH } = await import(
  "./capability-budget.js"
);

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

const session = (lane: "slack" | "repository-interactive") => ({
  auth: laneAuth(lane),
  id: `capability-budget:${lane}`,
});

describe("eve dynamic tool adapter", () => {
  it("admits qualified GitHub names from the actual application-owned override", {
    skip: !existsSync(
      new URL(`../../${COMPILED_MANIFEST_PATH}`, import.meta.url)
    ),
  }, async () => {
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const entry = manifest.dynamicTools.find(
      (candidate) =>
        candidate.sourceId === "ext-override:github:tools/github.ts"
    );
    assert.ok(entry);
    assert.equal(
      entry.extensionNamespace,
      undefined,
      "Eve 0.54 does not prefix directory overrides"
    );
    const [resolver] = await loadCompiledDynamicToolResolvers(
      [entry],
      APP_ROOT
    );
    assert.ok(resolver);
    assert.equal(
      resolver.extensionNamespace,
      undefined,
      "the adapter must not inject namespace metadata"
    );
    const admitted = await admitDynamicTools(
      resolver,
      session("repository-interactive")
    );
    assert.deepEqual(
      admitted
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
      GITHUB_TOOL_ALLOWLIST.map((name) => `github__${name}`).sort(
        (left, right) => left.localeCompare(right)
      )
    );
    assert.deepEqual(await admitDynamicTools(resolver, session("slack")), []);
  });
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
      dynamicToolCacheKey(ENTRY, APP_ROOT, session("repository-interactive").id)
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
