import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pullRequestReadinessPolicy } from "./approval.js";

/**
 * The extension config is checked as source text, because the extension module
 * only resolves inside eve's compiler and cannot be imported from a plain test
 * run. Only the `githubExtension({ ... })` call is scanned, so prose in the
 * file's documentation cannot satisfy an assertion on its own.
 *
 * Left unset, `requireApproval` makes the extension attach `always()` to every
 * write tool, so opening a pull request or leaving a comment raises an approval
 * card on every call. Slack cannot deliver an answer to one, and a Linear agent
 * session has nobody watching for one, so the run never finishes.
 */
const REQUIRE_APPROVAL_FALSE = /requireApproval:\s*false/u;
const MERGE_TOOL = /"\w*[Mm]erge\w*"/u;
const INTAKE_OVERRIDE =
  /createPullRequest:\s*\{\s*approval:\s*durableIntakeOnlyApproval\s*\}/u;
const READINESS_OVERRIDE =
  /updatePullRequest:\s*\{\s*approval:\s*durableReadinessApproval\s*\}/u;
const CALLBACK_VALUE = /(?:approval|toModelOutput):\s*([\w.]+)/gu;
/**
 * The five tools whose descriptors carry the extension's own `toModelOutput`.
 * Left alone, that callback has no durable descriptor, and eve 0.44 drops the
 * whole 31-tool map rather than the one entry.
 */
const MODEL_OUTPUT_TOOLS = [
  "compareCommits",
  "getCommit",
  "getFileContent",
  "getPullRequestContext",
  "listPullRequestFiles",
];
const DOC_ONLY_PHRASE = /load-bearing/u;

const source = readFileSync(
  new URL("../../extensions/github.ts", import.meta.url),
  "utf8"
);
const call = source.slice(source.indexOf("githubExtension({"));

const approvalFor = (toolInput: unknown) =>
  ({ toolInput, toolName: "updatePullRequest" }) as never;

describe("github extension config", () => {
  it("scans the call, not the documentation above it", () => {
    assert.ok(call.length > 0);
    assert.doesNotMatch(call, DOC_ONLY_PHRASE);
  });

  it("disables per-call approval on write tools", () => {
    assert.match(call, REQUIRE_APPROVAL_FALSE);
  });

  it("keeps merge tools out of the allowlist", () => {
    assert.doesNotMatch(call, MERGE_TOOL);
  });

  it("gates the readiness transition", () => {
    assert.match(call, READINESS_OVERRIDE);
  });

  it("gates pull request creation on the intake-only rule", () => {
    assert.match(call, INTAKE_OVERRIDE);
  });

  it("overrides the model output of every tool that ships its own", () => {
    for (const tool of MODEL_OUTPUT_TOOLS) {
      assert.match(
        call,
        new RegExp(
          `${tool}:\\s*\\{\\s*toModelOutput:\\s*durableModelOutput\\s*\\}`,
          "u"
        )
      );
    }
  });

  it("passes only durable callbacks, never a policy written elsewhere", () => {
    const values = [...call.matchAll(CALLBACK_VALUE)].map(([, value]) => value);
    assert.deepEqual(values, [
      "durableModelOutput", // compareCommits
      "durableIntakeOnlyApproval", // createPullRequest
      "durableModelOutput", // getCommit
      "durableModelOutput", // getFileContent
      "durableModelOutput", // getPullRequestContext
      "durableModelOutput", // listPullRequestFiles
      "durableReadinessApproval", // updatePullRequest
    ]);
  });
});

describe("pullRequestReadinessPolicy", () => {
  it("denies marking a pull request ready", () => {
    const status = pullRequestReadinessPolicy(approvalFor({ draft: false }));
    assert.equal(typeof status === "object" && status.type, "denied");
  });

  it("never parks, because no surface can answer a card", () => {
    for (const input of [{ draft: false }, { draft: true }, { body: "x" }]) {
      assert.notEqual(
        pullRequestReadinessPolicy(approvalFor(input)),
        "user-approval"
      );
    }
  });

  it("leaves every other update ungated", () => {
    for (const input of [
      { draft: true },
      { body: "new body" },
      { state: "closed" },
      { title: "new title" },
      undefined,
    ]) {
      assert.equal(
        pullRequestReadinessPolicy(approvalFor(input)),
        "not-applicable"
      );
    }
  });
});
