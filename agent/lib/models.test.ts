import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  gatewayRouting,
  MODELS,
  modelFor,
  parseModelOverrides,
  rootCallOptions,
} = await import("./models.js");

describe("MODELS", () => {
  it("runs the general root on GPT-6.1 Sol and no root slot on DeepSeek", () => {
    assert.equal(MODELS.orchestrator, "openai/gpt-6.1-sol");
    for (const slot of ["orchestrator", "triage", "widget"] as const) {
      assert.ok(!MODELS[slot].startsWith("deepseek/"), slot);
    }
  });
});

describe("gatewayRouting", () => {
  it("orders a deepseek id onto the providers that accept a mixed history", () => {
    assert.deepEqual(gatewayRouting("deepseek/deepseek-v4.1-flash"), {
      providerOptions: {
        gateway: {
          order: [
            "fireworks",
            "wafer",
            "alibaba",
            "deepinfra",
            "novita",
            "modal",
          ],
        },
      },
    });
  });

  it("leaves every other id on the gateway default", () => {
    assert.equal(gatewayRouting("anthropic/claude-opus-4.8"), undefined);
  });
});

describe("parseModelOverrides", () => {
  it("strips obsolete slots while retaining current overrides", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        analyst: "deepseek/deepseek-v4-pro-0813",
        chat: "anthropic/claude-opus-4.8",
        classifier: "deepseek/deepseek-v4-pro-0813",
        implementer: "deepseek/deepseek-v4-pro-0813",
        investigator: "deepseek/deepseek-v4-pro-0813",
        orchestrator: "deepseek/deepseek-v4-pro-0813",
        researcher: "deepseek/deepseek-v4-pro-0813",
        reviewer: "anthropic/claude-opus-4.8",
      })
    );
    assert.deepEqual(overrides, {
      orchestrator: "deepseek/deepseek-v4-pro-0813",
    });
  });

  it("keeps known slots with valid ids", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        critic: "anthropic/claude-opus-4.8",
        orchestrator: "deepseek/deepseek-v4-pro-0813",
      })
    );
    assert.deepEqual(overrides, {
      critic: "anthropic/claude-opus-4.8",
      orchestrator: "deepseek/deepseek-v4-pro-0813",
    });
  });

  it("drops invalid ids", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        critic: "anthropic/claude-opus-4.8",
        orchestrator: "not a valid id",
      })
    );
    assert.deepEqual(overrides, { critic: "anthropic/claude-opus-4.8" });
  });

  it("drops non-string values", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        critic: "anthropic/claude-opus-4.8",
        orchestrator: 123,
      })
    );
    assert.deepEqual(overrides, { critic: "anthropic/claude-opus-4.8" });
  });
});

const PROXY_MISSING = /CLIPROXY_BASE_URL and CLIPROXY_API_KEY/;

describe("modelFor", () => {
  const withProxy = (
    env: { CLIPROXY_API_KEY?: string; CLIPROXY_BASE_URL?: string },
    run: () => void
  ) => {
    const saved = {
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
      CLIPROXY_BASE_URL: process.env.CLIPROXY_BASE_URL,
    };
    for (const key of ["CLIPROXY_API_KEY", "CLIPROXY_BASE_URL"] as const) {
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    try {
      run();
    } finally {
      for (const key of ["CLIPROXY_API_KEY", "CLIPROXY_BASE_URL"] as const) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
  const proxy = {
    CLIPROXY_API_KEY: "test-key",
    CLIPROXY_BASE_URL: "https://proxy.test/v1",
  };
  const describeModel = (id: string) => {
    const { modelId, provider } = modelFor(id);
    return { modelId, provider };
  };

  it("sends a Claude id to the proxy with its dashed name", () => {
    withProxy(proxy, () => {
      const { modelId, provider } = describeModel(
        "anthropic/claude-sonnet-5.5"
      );
      assert.equal(provider, "anthropic.messages");
      assert.equal(modelId, "claude-sonnet-5-5");
    });
  });

  it("refuses a Claude id when the proxy is not fully set", () => {
    withProxy({ CLIPROXY_BASE_URL: proxy.CLIPROXY_BASE_URL }, () => {
      assert.throws(
        () => modelFor("anthropic/claude-sonnet-5.5"),
        PROXY_MISSING
      );
    });
  });

  it("routes the general root through the CLI Proxy Responses API", () => {
    withProxy(proxy, () => {
      assert.deepEqual(describeModel(MODELS.orchestrator), {
        modelId: "gpt-6.1-sol",
        provider: "openai.responses",
      });
    });
  });

  it("refuses Sol without complete proxy credentials", () => {
    withProxy({}, () =>
      assert.throws(() => modelFor(MODELS.orchestrator), PROXY_MISSING)
    );
  });

  it("keeps every other id on the gateway", () => {
    withProxy(proxy, () => {
      assert.deepEqual(describeModel("deepseek/deepseek-v4-pro-0813"), {
        modelId: "deepseek/deepseek-v4-pro-0813",
        provider: "gateway",
      });
    });
  });
});

it("sends Sol tool calls and reasoning to the configured proxy Responses endpoint", async (t) => {
  const { generateText, tool } = await import("ai");
  const { z } = await import("zod");
  const savedKey = process.env.CLIPROXY_API_KEY;
  const savedURL = process.env.CLIPROXY_BASE_URL;
  process.env.CLIPROXY_API_KEY = "test-key";
  process.env.CLIPROXY_BASE_URL = "https://proxy.test/v1";
  t.after(() => {
    for (const [key, value] of Object.entries({
      CLIPROXY_API_KEY: savedKey,
      CLIPROXY_BASE_URL: savedURL,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(url));
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-key"
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal(body.reasoning.effort, "medium");
      assert.equal(body.tools[0].type, "function");
      assert.equal(body.tools[0].name, "lookup");
      return Promise.resolve(
        Response.json({
          created_at: 0,
          id: "resp_test",
          model: "gpt-6.1-sol",
          object: "response",
          output: [
            {
              arguments: '{"key":"test"}',
              call_id: "call_test",
              id: "fc_test",
              name: "lookup",
              type: "function_call",
            },
          ],
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        })
      );
    }
  );
  const result = await generateText({
    maxRetries: 0,
    model: modelFor(MODELS.orchestrator),
    prompt: "Look up test",
    ...rootCallOptions(MODELS.orchestrator),
    tools: { lookup: tool({ inputSchema: z.object({ key: z.string() }) }) },
  });
  assert.deepEqual(requests, ["https://proxy.test/v1/responses"]);
  assert.equal(result.toolCalls[0]?.toolName, "lookup");
  assert.deepEqual(result.toolCalls[0]?.input, { key: "test" });
});
