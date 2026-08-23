import assert from "node:assert/strict";
import { describe, it } from "node:test";

// prompts.ts reads LINEAR_CONNECTOR and PLANETSCALE_MCP_CONNECTOR at module
// load (both auth providers live in constants.ts).
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";
process.env.PLANETSCALE_MCP_CONNECTOR =
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

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

  it("requires the Slack wording skill on both root paths", () => {
    for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
      assert.ok(
        prompt.includes(
          "When the active channel is Slack, load `slack-wording` before drafting any reply or question."
        )
      );
    }
  });
});
