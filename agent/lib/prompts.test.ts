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
const { FOREMAN_BRANCH_PREFIX } = await import("./constants.js");

const CHANNEL_NAME = /Linear|Slack/;
const REPLACES_PREPARED = /`prepare_repository` replaces the prepared one/u;
const NEVER_REPLACED = /never replaced/u;
const SIGNED_BINDING = /every repository tool to refuse anything else/u;

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

describe("repository guidance", () => {
  it("describes attended replacement and the checkouts that are never replaced", () => {
    for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
      assert.match(prompt, REPLACES_PREPARED);
      assert.match(prompt, NEVER_REPLACED);
    }
  });

  it("keeps a signed GitHub session bound for the whole session", () => {
    for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
      assert.match(prompt, SIGNED_BINDING);
    }
  });

  it("asks direct work for a feature branch without a required prefix", () => {
    // `push_branch` validates the name and nothing else, so the general path
    // must not send the model renaming a branch it can already deliver.
    assert.ok(!GENERAL_PROMPT.includes(FOREMAN_BRANCH_PREFIX));
    assert.ok(GENERAL_PROMPT.includes("create a feature branch"));
  });

  it("keeps the factory's own branch prefix on the implementer", () => {
    // Ownership, not permission: the GitHub channel recognizes the factory's
    // pull requests by this prefix for red-CI stabilization.
    assert.ok(
      PIPELINE.includes(`pushes a \`${FOREMAN_BRANCH_PREFIX}\` feature branch`)
    );
  });
});
