import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { gatewayRouting, modelFor, parseModelOverrides } = await import(
  "./models.js"
);

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

  it("keeps every other id on the gateway", () => {
    withProxy(proxy, () => {
      assert.deepEqual(describeModel("deepseek/deepseek-v4-pro-0813"), {
        modelId: "deepseek/deepseek-v4-pro-0813",
        provider: "gateway",
      });
    });
  });
});
