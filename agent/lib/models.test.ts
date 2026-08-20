import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { parseModelOverrides } = await import("./models.js");

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

  it("throws on non-string values", () => {
    assert.throws(() =>
      parseModelOverrides(JSON.stringify({ orchestrator: 123 }))
    );
  });
});
