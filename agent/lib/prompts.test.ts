import assert from "node:assert/strict";
import { describe, it } from "node:test";

// prompts.ts imports constants.ts, which reads FACTORY_REPO and LINEAR_CONNECTOR
// at module load; set them before the dynamic import below.
process.env.FACTORY_REPO = "acme/widgets";
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const { FACTORY_PROMPT, GENERAL_PROMPT, PIPELINE, selectPrompt } = await import(
  "./prompts.js"
);
const { AUTONOMOUS_PRINCIPAL } = await import("./trust.js");

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
});
