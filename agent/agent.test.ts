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

for (const issuer of [
  "slack:T0A9AUZJXC2",
  "foreman:fin-context-preview",
  "foreman:fin-preview",
]) {
  it(`accepts the wrapped ${issuer} model under Eve's documented live-step contract`, async (t) => {
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-only-no-network";
    t.after(() => {
      if (previousKey === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = previousKey;
      }
    });
    const toolCall = {
      input: "{}",
      toolCallId: "issuer-check",
      toolName: "bash",
      type: "tool-call",
    };
    let providerRequest: { tools?: unknown; toolChoice?: unknown } | undefined;
    t.mock.method(
      globalThis,
      "fetch",
      (url: string | URL, init?: RequestInit) => {
        if (
          String(url) !== "https://ai-gateway.vercel.sh/v4/ai/language-model"
        ) {
          return Promise.reject(new Error("No network in this test"));
        }
        const body = init?.body;
        assert.ok(typeof body === "string");
        providerRequest = JSON.parse(body);
        return Promise.resolve(
          Response.json({
            content: [toolCall],
            finishReason: { raw: "tool_calls", unified: "tool-calls" },
            usage: {
              inputTokens: {
                cacheRead: 0,
                cacheWrite: 0,
                noCache: 1,
                total: 1,
              },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
        );
      }
    );
    // White-box regression against the lockfile's Eve 0.54.2 runtime. This private
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
      { session: { auth: { initiator: { issuer } } } },
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
    // Exercise the selected model through its public provider boundary. Swapping
    // the issuer branches must fail even though both satisfy Eve's model contract.
    const tools = [
      { inputSchema: { type: "object" }, name: "bash", type: "function" },
    ];
    const generated = selection.model.doGenerate({
      prompt: [],
      toolChoice: { type: "auto" },
      tools,
    });
    if (issuer === "slack:T0A9AUZJXC2") {
      assert.deepEqual((await generated).content, [toolCall]);
      assert.deepEqual(providerRequest?.tools, tools);
      assert.deepEqual(providerRequest?.toolChoice, { type: "auto" });
    } else {
      await assert.rejects(generated, {
        message: "Fin context Preview cannot execute tools.",
      });
      assert.deepEqual(providerRequest?.tools, []);
      assert.deepEqual(providerRequest?.toolChoice, { type: "none" });
    }
  });
}
