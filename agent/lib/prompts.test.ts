import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The retained Linear attachment credential is initialized by constants.ts.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const { GENERAL_PROMPT, composePrompt } = await import("./prompts.js");

const REPLACEMENT_CLAUSE =
  "In an attended session you may name a different repository later and `prepare_repository` replaces the prepared one, reporting `previous` and `current` so you can say which repository the work moved to.";
const NEVER_REPLACED_CLAUSE =
  "A signed GitHub checkout, an unattended run, and a checkout at `/workspace` are never replaced; the tool explains the refusal and leaves the session on the checkout it had.";

// GitHub API tools do not rebind model-supplied owner/repo to the signed repository.
// The prompt must request that binding without claiming it is enforced for them.
const SIGNED_BINDING_CLAUSE =
  "pass it as the `owner` and `repo` of every `github__` call. `prepare_repository` and `push_branch` check that binding at runtime, but the `github__` tools do not: they act on whatever repository they are handed, so naming another one there is a mistake nothing catches.";

describe("composePrompt", () => {
  it("uses the general prompt by default", () => {
    assert.equal(composePrompt(), GENERAL_PROMPT);
  });

  it("identifies delegated support work and passes its evidence context without root delivery responsibilities", () => {
    assert.ok(
      GENERAL_PROMPT.includes(
        'For scheduled support delegation, begin the child message with "Delegated support evidence task", include the question, relevant source identifiers and existing findings, and require read-only evidence returned to the parent.'
      )
    );
    assert.ok(
      GENERAL_PROMPT.includes(
        "The root keeps the investigation journal, Linear writes, and Slack delivery."
      )
    );
  });

  it("limits the Slack wording skill to the two intended channels", () => {
    assert.ok(
      GENERAL_PROMPT.includes(
        "Load `slack-wording` only when the delivered Slack channel ID is C0BBPVC3N2X (acquisity-feedback) or C0BC011NAQL (acquisity-refunds-request)."
      )
    );
    assert.ok(
      GENERAL_PROMPT.includes(
        "Its restrictions do not apply in other channels."
      )
    );
  });
});

describe("repository guidance", () => {
  it("prepares a delegated repository before declaring its gated GitHub tools missing", () => {
    assert.ok(
      GENERAL_PROMPT.includes(
        "Call `prepare_repository` before repository work, including in a delegated child even when the parent already prepared the shared checkout."
      )
    );
    assert.ok(
      GENERAL_PROMPT.includes(
        "Only if none are available on the next model step after `prepare_repository` succeeds, report that the GitHub extension failed to resolve"
      )
    );
    assert.ok(
      GENERAL_PROMPT.includes(
        "For repository work, include the selected `owner/repo` and tell the child to call `prepare_repository` before working."
      )
    );
    assert.ok(!GENERAL_PROMPT.includes("When a turn has none of them"));
  });

  it("describes attended replacement and the checkouts that are never replaced", () => {
    assert.ok(GENERAL_PROMPT.includes(REPLACEMENT_CLAUSE));
    assert.ok(GENERAL_PROMPT.includes(NEVER_REPLACED_CLAUSE));
  });

  it("asks for the signed repository on every github__ call, without promising a runtime gate", () => {
    assert.ok(GENERAL_PROMPT.includes(SIGNED_BINDING_CLAUSE));
    assert.ok(!GENERAL_PROMPT.includes("every repository tool to refuse"));
  });

  it("asks direct work for a feature branch without a required prefix", () => {
    assert.ok(GENERAL_PROMPT.includes("create a feature branch"));
    assert.ok(GENERAL_PROMPT.includes("No prefix is required"));
  });

  it("summarizes what validateBranch actually accepts", () => {
    // A component like release.lock is refused, even when the name looks plain.
    assert.ok(
      GENERAL_PROMPT.includes(
        "No prefix is required, and `push_branch` accepts exactly the names `validateBranch` approves: letters, digits, `.`, `_`, `-`, and `/`, starting and ending with a letter or digit, with no `..` or `//`, and no slash-separated component that starts with `.`, ends with `.`, or ends with `.lock`. Protected branches, `refs/` names, and `HEAD` are refused."
      )
    );
  });
});
