import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const { default: rootAgent, rootModelSlot } = await import("./agent.js");

describe("root agent limits", () => {
  it("disables the default 40M usage window and nothing else", () => {
    // eve's default usage window can park a long Slack thread on a
    // Continue/Stop card the channel cannot answer. Pin the exact keys so no
    // other limit (session timeout) gets configured by accident.
    assert.deepEqual(Object.keys(rootAgent.limits ?? {}), ["sessionUsage"]);
    const { sessionUsage } = rootAgent.limits ?? {};
    assert.equal(typeof sessionUsage, "function");
    const huge = { inputTokens: 1e12, outputTokens: 1e12 };
    assert.equal(
      (sessionUsage as (usage: unknown) => boolean)({
        total: huge,
        window: huge,
      }),
      false
    );
  });
});

describe("root model slot", () => {
  it("puts triage intake on Opus and leaves widget and other sessions alone", async () => {
    const [{ MODELS }, { stampTriageIntake }, { WIDGET_SUPPORT_ISSUER }] =
      await Promise.all([
        import("./lib/models.js"),
        import("./lib/trust.js"),
        import("./lib/widget-scope.js"),
      ]);
    const auth = {
      attributes: {},
      authenticator: "slack",
      issuer: "slack",
      principalId: "U123",
      principalType: "user",
    } as unknown as Parameters<typeof rootModelSlot>[0] & object;
    const triage = rootModelSlot(stampTriageIntake(auth));
    assert.equal(triage, "triage");
    assert.equal(MODELS[triage], "anthropic/claude-opus-5.5");
    assert.equal(rootModelSlot(auth), "orchestrator");
    assert.equal(rootModelSlot(null), "orchestrator");
    assert.equal(
      rootModelSlot({ ...auth, issuer: WIDGET_SUPPORT_ISSUER }),
      "widget"
    );
  });
});

it("accepts the wrapped root model under Eve's documented live-step contract", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("No network in this test"))
  );
  // White-box regression against the lockfile's Eve 0.83.2 runtime. This private
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
  const selection = await Reflect.apply(resolve, undefined, [
    {},
    { session: { auth: { current: null, initiator: null } } },
  ]);
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
