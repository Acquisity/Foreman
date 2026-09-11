import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { gatewayRouting, parseModelOverrides } = await import("./models.js");

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
  it("strips a stale chat key", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        chat: "anthropic/claude-opus-4.8",
        orchestrator: "deepseek/deepseek-v4-pro-0813",
      })
    );
    assert.deepEqual(overrides, {
      orchestrator: "deepseek/deepseek-v4-pro-0813",
    });
  });

  it("keeps known slots with valid ids", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        orchestrator: "deepseek/deepseek-v4-pro-0813",
        reviewer: "anthropic/claude-opus-4.8",
      })
    );
    assert.deepEqual(overrides, {
      orchestrator: "deepseek/deepseek-v4-pro-0813",
      reviewer: "anthropic/claude-opus-4.8",
    });
  });

  it("drops invalid ids", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        orchestrator: "not a valid id",
        reviewer: "anthropic/claude-opus-4.8",
      })
    );
    assert.deepEqual(overrides, { reviewer: "anthropic/claude-opus-4.8" });
  });

  it("drops non-string values", () => {
    const overrides = parseModelOverrides(
      JSON.stringify({
        orchestrator: 123,
        reviewer: "anthropic/claude-opus-4.8",
      })
    );
    assert.deepEqual(overrides, { reviewer: "anthropic/claude-opus-4.8" });
  });
});
