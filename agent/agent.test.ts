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

it("resolves the wrapped root model through Eve's live step selection", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("No network in this test"))
  );
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
  assert.equal(resolved.model, selection);
  assert.equal(typeof resolved.model.doStream, "function");
});
