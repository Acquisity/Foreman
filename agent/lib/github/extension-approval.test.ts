import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Source-level check, because the extension module only resolves inside eve's
 * compiler and cannot be imported from a plain test run.
 *
 * Left unset, `requireApproval` makes the extension attach `always()` to every
 * write tool, so opening a pull request or leaving a comment raises an approval
 * card on every call. Slack cannot deliver an answer to one, which parks the
 * session for good. The allowlist, not a per-call card, bounds these writes.
 */
const REQUIRE_APPROVAL_FALSE = /requireApproval:\s*false/u;
const MERGE_TOOL = /"\w*[Mm]erge\w*"/u;

describe("github extension", () => {
  const source = readFileSync(
    new URL("../../extensions/github.ts", import.meta.url),
    "utf8"
  );

  it("disables per-call approval on write tools", () => {
    assert.match(source, REQUIRE_APPROVAL_FALSE);
  });

  it("keeps merge tools out of the allowlist", () => {
    assert.doesNotMatch(source, MERGE_TOOL);
  });
});
