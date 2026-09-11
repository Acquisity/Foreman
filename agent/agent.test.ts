import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const { default: rootAgent } = await import("./agent.js");

describe("root agent limits", () => {
  it("disables the default 40M per-session input budget and nothing else", () => {
    // Cached prompt re-reads count as provider-reported input on every model
    // call, so eve's default input budget can park a long Slack thread on an
    // Approve/Stop card the channel cannot answer. Pin the exact object so no
    // other limit (output cap, session timeout) gets configured by accident.
    assert.deepEqual(rootAgent.limits, { maxInputTokensPerSession: false });
  });
});

it("accepts the wrapped root model under Eve's documented live-step contract", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("No network in this test"))
  );
  // White-box regression against the lockfile's Eve 0.44.0 runtime. This private
  // import deliberately fails on internal API drift so upgrades require review.
  // It checks selection validation under the documented step -> live contract,
  // not lifecycle dispatch end to end; no public API exposes this validation.
  const eveRoot = pathToFileURL(
    createRequire(import.meta.url).resolve("eve/package.json")
  );
  const { resolveRuntimeModelSelection } = await import(
    new URL("dist/src/runtime/agent/resolve-model.js", eveRoot).href
  );
  const { events } = rootAgent.model;
  assert.deepEqual(Object.keys(events), ["step.started"]);
  const [[event, resolve]] = Object.entries(events);
  const selection = await Reflect.apply(resolve, undefined, []);
  const resolved = await resolveRuntimeModelSelection({
    catalog: {
      getByGatewayId: (id: string) =>
        Promise.resolve({
          contextWindowTokens: 200_000,
          resolvedModelId: id,
        }),
    },
    durability: event === "step.started" ? "live" : "durable",
    selection,
    state: { get: () => undefined, set: () => undefined },
  });
  assert.equal(resolved.model, selection.model);
  assert.equal(typeof resolved.model.doStream, "function");
  // The DeepSeek routing rides on the selection and eve forwards it as providerOptions.
  // The order itself is pinned in models.test.ts; this only checks the forwarding.
  const { gatewayRouting, MODELS } = await import("./lib/models.js");
  const expected = gatewayRouting(MODELS.orchestrator);
  assert.ok(expected);
  assert.deepEqual(
    resolved.reference.providerOptions,
    expected.providerOptions
  );
});
