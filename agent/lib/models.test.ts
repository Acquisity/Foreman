import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { MODELS, parseModelOverrides } = await import("./models.js");

it("keeps triage critic independent from factory review", () => {
  assert.equal(MODELS.triageCritic, "openai/gpt-5.6-sol");
  assert.equal(MODELS.reviewer, "anthropic/claude-opus-4.8");
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
