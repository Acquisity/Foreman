import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineTool } from "eve/tools";
import { laneAuth } from "../agent/lib/capability-budget.ts";
import {
  admitDynamicTools,
  installedEveVersion,
} from "../agent/lib/eve-dynamic-tools.ts";
import { GITHUB_TOOL_ALLOWLIST } from "../agent/lib/github/tool-allowlist.ts";

// Run after sourcing .env.example and building. Importing the actual server in
// this process registers extension configuration and compiled callback steps.
// The proof resolves definitions and checks local approval predicates. It never
// calls a provider tool.
process.env.NITRO_HOST = "127.0.0.1";
process.env.NITRO_PORT = "0";
const UNSTAMPED_PROJECTION = /toModelOutput.*durable descriptor/u;

async function verify() {
  await import("../.output/server/index.mjs");
  const require = createRequire(import.meta.url);
  const evePackage = pathToFileURL(require.resolve("eve/package.json"));
  // Eve 0.54 inlines installed extensions into the server entry. Read the
  // module map that this actual server boot registered, never a source import
  // or a second locally compiled bundle.
  const { readBundledCompiledArtifacts } = await import(
    new URL("./dist/src/runtime/loaders/bundled-artifacts.js", evePackage).href
  );
  const artifacts = readBundledCompiledArtifacts();
  assert.ok(
    artifacts,
    "The built server must register its compiled artifacts."
  );
  assert.equal(artifacts.metadata.generator.version, installedEveVersion());
  const entry = artifacts.manifest.dynamicTools.find(
    (tool) => tool.slug === "github__github"
  );
  assert.ok(entry, "The built manifest must mount the GitHub resolver.");
  const { resolveDynamicToolDefinition } = await import(
    new URL("./dist/src/runtime/resolve-dynamic-tool.js", evePackage).href
  );
  const resolver = await resolveDynamicToolDefinition(
    entry,
    artifacts.moduleMap,
    "__root__"
  );
  const expectedNames = GITHUB_TOOL_ALLOWLIST.map(
    (name) => `github__${name}`
  ).sort((left, right) => left.localeCompare(right));
  const admitted = await admitDynamicTools(resolver, {
    auth: laneAuth("repository-interactive"),
    id: "built-github-proof",
  });
  assert.deepEqual(
    admitted
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right)),
    expectedNames,
    "Eve must admit the exact qualified model-visible names from the built artifact."
  );
  await Promise.all(
    ["slack", "slack-intake-only"].map(async (lane) => {
      assert.deepEqual(
        await admitDynamicTools(resolver, {
          auth: laneAuth(lane),
          id: `built-github-proof:${lane}`,
        }),
        [],
        `${lane} must omit GitHub in native dispatch.`
      );
    })
  );
  assert.equal(typeof resolver?.events?.["step.started"], "function");
  const resolve = (lane) =>
    resolver.events["step.started"](
      {
        data: { stepIndex: 0, turnId: "built-github-proof" },
        type: "step.started",
      },
      {
        session: {
          auth: { current: laneAuth(lane) },
          id: "built-github-proof",
        },
      }
    );
  const { validateDurableDynamicToolCallbacks } = await import(
    new URL("./dist/src/context/dynamic-tool-lifecycle.js", evePackage).href
  );
  const entries = await resolve("repository-interactive");
  const names = Object.keys(entries).sort((left, right) =>
    left.localeCompare(right)
  );
  assert.equal(
    names.length,
    31,
    "The built GitHub surface must contain 31 tools."
  );
  assert.deepEqual(names, expectedNames);

  const owner = (entryKey) => ({
    entryKey,
    name: entryKey,
    resolverSlug: "github__github",
    scope: "step",
    sessionId: "built-github-proof",
  });
  const callbackPhases = {};
  for (const entryKey of names) {
    const identity = owner(entryKey);
    // Eve 0.54 registers every callback under its exact resolver owner.
    const callbacks = validateDurableDynamicToolCallbacks(
      identity.name,
      entries[entryKey],
      identity
    );
    assert.deepEqual(
      Object.keys(callbacks).sort(),
      ["approvalRequest", "execute", "toModelOutput"],
      `Unexpected durable callback phases for ${identity.name}.`
    );
    for (const phase of Object.keys(callbacks)) {
      callbackPhases[phase] = (callbackPhases[phase] ?? 0) + 1;
    }
  }

  // The two stamped gates must stay distinct even when their phases match.
  const approvalContext = {
    session: { auth: { current: null, initiator: null } },
    toolInput: { draft: false },
  };
  assert.equal(
    await entries.github__createPullRequest.approval({
      ...approvalContext,
      toolName: "github__createPullRequest",
    }),
    "not-applicable",
    "Pull request creation must use the intake-only approval gate."
  );
  assert.equal(
    (
      await entries.github__updatePullRequest.approval({
        ...approvalContext,
        toolName: "github__updatePullRequest",
      })
    ).type,
    "denied",
    "Pull request updates must use the readiness approval gate."
  );

  // Re-author just one projection without the compiler transform. This must
  // fail even though every other callback and all 31 tool names remain valid.
  const broken = defineTool({
    ...entries.github__getFileContent,
    toModelOutput: () => ({ type: "json", value: null }),
  });
  const identity = owner("github__getFileContent");
  assert.throws(
    () => validateDurableDynamicToolCallbacks(identity.name, broken, identity),
    UNSTAMPED_PROJECTION
  );

  return {
    allowlistMatches: true,
    approvalPoliciesMatch: true,
    callbackPhases,
    count: names.length,
    mountedGateMatches: true,
    nativeDispatchNamesMatch: true,
    unstampedCallbackRejected: true,
  };
}

let exitCode = 0;
try {
  const result = await verify();
  await new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, resolve);
  });
} catch (error) {
  exitCode = 1;
  await new Promise((resolve) => {
    process.stderr.write(`${String(error)}\n`, resolve);
  });
}
// Nitro's node entry starts a listener without exporting a close handle. This
// is a one-shot proof; exiting also releases its ephemeral local listener.
process.exit(exitCode);
