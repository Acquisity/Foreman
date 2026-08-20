import assert from "node:assert/strict";
import { describe, it } from "node:test";

// prompts.ts reads LINEAR_CONNECTOR at module load.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const { FACTORY_PROMPT, GENERAL_MODE, GENERAL_PROMPT, PIPELINE, selectPrompt } =
  await import("./prompts.js");
const { AUTONOMOUS_PRINCIPAL } = await import("./trust.js");

const CHANNEL_NAME = /Linear|Slack/;

describe("selectPrompt", () => {
  it("selects FACTORY_PROMPT for the autonomous principal and inlines the pipeline", () => {
    const prompt = selectPrompt(AUTONOMOUS_PRINCIPAL);
    assert.equal(prompt, FACTORY_PROMPT);
    assert.ok(prompt.includes(PIPELINE));
  });

  it("selects GENERAL_PROMPT for a null or absent principal and omits the pipeline", () => {
    for (const principal of [null, undefined]) {
      const prompt = selectPrompt(principal);
      assert.equal(prompt, GENERAL_PROMPT);
      assert.ok(!prompt.includes(PIPELINE));
    }
  });

  it("selects GENERAL_PROMPT for trusted and ordinary principals and omits the pipeline", () => {
    // A trusted principal is a real GitHub actor (numeric `github:<id>`); an
    // ordinary principal is any other non-autonomous caller.
    for (const principal of ["github:12345", "github:some-user", "eve:app"]) {
      const prompt = selectPrompt(principal);
      assert.equal(prompt, GENERAL_PROMPT);
      assert.ok(!prompt.includes(PIPELINE));
    }
  });

  it("does not name any channel in general-mode routing", () => {
    assert.ok(!CHANNEL_NAME.test(GENERAL_MODE));
  });
});
