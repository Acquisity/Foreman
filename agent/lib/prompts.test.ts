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

/**
 * The full clauses the repository guidance has to keep, not fragments of
 * them: a substring match still passes when the attended condition or one of
 * the three protected checkouts drops out of the sentence.
 */
const REPLACEMENT_CLAUSE =
  "In an attended session you may name a different repository later and `prepare_repository` replaces the prepared one, reporting `previous` and `current` so you can say which repository the work moved to.";
const NEVER_REPLACED_CLAUSE =
  "A signed GitHub checkout, an unattended run, and a checkout at `/workspace` are never replaced; the tool explains the refusal and leaves the session on the checkout it had.";
const PROTECTED_CHECKOUTS = [
  "A signed GitHub checkout",
  "an unattended run",
  "a checkout at `/workspace`",
];

/**
 * `github__` tools take `owner` and `repo` from the model, and nothing in
 * `agent/extensions/github.ts` rebinds them to the signed repository, so the
 * prompt must ask for the binding rather than promise it is enforced.
 */
const SIGNED_BINDING_CLAUSE =
  "pass it as the `owner` and `repo` of every `github__` call. Only `prepare_repository` and `push_branch` check that binding at runtime; the `github__` tools act on whatever repository they are handed, so naming another one there is a mistake nothing catches.";

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
      assert.ok(prompt.includes(REPLACEMENT_CLAUSE));
      assert.ok(prompt.includes(NEVER_REPLACED_CLAUSE));
      for (const checkout of PROTECTED_CHECKOUTS) {
        assert.ok(prompt.includes(checkout));
      }
    }
  });

  it("asks for the signed repository on every github__ call, without promising a runtime gate", () => {
    for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
      assert.ok(prompt.includes(SIGNED_BINDING_CLAUSE));
      assert.ok(!prompt.includes("every repository tool to refuse"));
    }
  });

  it("asks direct work for a feature branch without a required prefix", () => {
    // `push_branch` validates the name and nothing else, so the general path
    // must not send the model renaming a branch it can already deliver.
    assert.ok(!GENERAL_PROMPT.includes(FOREMAN_BRANCH_PREFIX));
    assert.ok(GENERAL_PROMPT.includes("create a feature branch"));
  });

  it("summarizes what validateBranch actually accepts", () => {
    // A plain-looking name such as `feature/release.lock` is refused, so the
    // prompt has to carry the component rules and not just "any plain name".
    assert.ok(
      GENERAL_PROMPT.includes(
        "No prefix is required, and `push_branch` accepts exactly the names `validateBranch` approves: letters, digits, `.`, `_`, `-`, and `/`, starting and ending with a letter or digit, with no `..` or `//`, and no slash-separated component that starts with `.`, ends with `.`, or ends with `.lock`. Protected branches, `refs/` names, and `HEAD` are refused."
      )
    );
  });

  it("keeps the factory's own branch prefix on the implementer", () => {
    // Ownership, not permission: the GitHub channel recognizes the factory's
    // pull requests by this prefix for red-CI stabilization.
    assert.ok(
      PIPELINE.includes(`pushes a \`${FOREMAN_BRANCH_PREFIX}\` feature branch`)
    );
  });
});
