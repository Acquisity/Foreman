import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { defineTool } from "eve/tools";
import { GITHUB_TOOL_ALLOWLIST } from "../agent/lib/github/tool-allowlist.ts";

// Run after sourcing .env.example and building. Importing the actual server in
// this process registers extension configuration and compiled callback steps.
// The proof only resolves definitions; it never calls a provider tool.
process.env.NITRO_HOST = "127.0.0.1";
process.env.NITRO_PORT = "0";
const UNSTAMPED_PROJECTION = /toModelOutput.*durable descriptor/u;

async function verify() {
  await import("../.output/server/index.mjs");
  const bundle = await import(
    "../.output/server/_libs/@github-tools/eve-extension.mjs"
  );
  // Nitro aliases chunk exports, so the authored default is not necessarily
  // exported as "default". Require exactly one dynamic resolver in this chunk.
  const resolvers = Object.values(bundle).filter(
    (entry) => typeof entry?.events?.["step.started"] === "function"
  );
  assert.equal(resolvers.length, 1, "Expected one built GitHub resolver.");
  const [resolver] = resolvers;
  const t = { default: resolver };
  const require = createRequire(import.meta.url);
  const evePackage = pathToFileURL(require.resolve("eve/package.json"));
  const { validateDurableDynamicToolCallbacks } = await import(
    new URL("./dist/src/context/dynamic-tool-lifecycle.js", evePackage).href
  );
  const entries = await t.default.events["step.started"]();
  const names = Object.keys(entries).sort();
  assert.equal(
    names.length,
    31,
    "The built GitHub surface must contain 31 tools."
  );
  assert.deepEqual(names, [...GITHUB_TOOL_ALLOWLIST].sort());

  const owner = (entryKey) => ({
    entryKey,
    name: `github__${entryKey}`,
    resolverSlug: "github__github",
    scope: "step",
    sessionId: "built-github-proof",
  });
  const expectedCallbacks = {
    compareCommits: ["execute", "toModelOutput"],
    createPullRequest: ["approvalRequest", "execute"],
    getCommit: ["execute", "toModelOutput"],
    getFileContent: ["execute", "toModelOutput"],
    getPullRequestContext: ["execute", "toModelOutput"],
    listPullRequestFiles: ["execute", "toModelOutput"],
    updatePullRequest: ["approvalRequest", "execute"],
  };
  const callbackPhases = {};
  for (const entryKey of names) {
    const identity = owner(entryKey);
    // Eve 0.44 ignores argument three; 0.54 uses it for callback ownership.
    const callbacks = validateDurableDynamicToolCallbacks(
      identity.name,
      entries[entryKey],
      identity
    );
    assert.deepEqual(
      Object.keys(callbacks).sort(),
      [...(expectedCallbacks[entryKey] ?? ["execute"])].sort(),
      `Unexpected durable callback phases for ${identity.name}.`
    );
    for (const phase of Object.keys(callbacks)) {
      callbackPhases[phase] = (callbackPhases[phase] ?? 0) + 1;
    }
  }

  // Re-author just one projection without the compiler transform. This must
  // fail even though every other callback and all 31 tool names remain valid.
  const broken = defineTool({
    ...entries.getFileContent,
    toModelOutput: () => ({ type: "json", value: null }),
  });
  const identity = owner("getFileContent");
  assert.throws(
    () => validateDurableDynamicToolCallbacks(identity.name, broken, identity),
    UNSTAMPED_PROJECTION
  );

  return {
    allowlistMatches: true,
    callbackPhases,
    count: names.length,
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
