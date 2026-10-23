import assert from "node:assert/strict";
import { test } from "node:test";
import { triageDocumentGaps } from "./triage-document.js";

const head = (lines: string[]) =>
  [
    "# Triage investigation",
    "",
    "**Ticket**: ENG-1",
    ...lines,
    "",
    "## Claim",
  ].join("\n");

test("a triage document needs both a confidence line and a review line", () => {
  const confidence =
    "**Confidence**: verdict 0.82, classification 0.7, path 1.0";
  for (const review of [
    "**Review**: Pending critic",
    "**Review**: Approved 2026-10-23T08:00:00.000Z at abc",
    "**Review**: Adjudicated 2026-10-23T08:00:00.000Z at abc: CHALLENGE, settled",
    "**Review**: Blocked 2026-10-23T08:00:00.000Z at abc: CHALLENGE twice",
    "**Review**: Stopped: NEEDS_HUMAN_URGENT",
    "**Review**: Not required: every evidence lane ran",
  ]) {
    assert.deepEqual(
      triageDocumentGaps(head([confidence, review])),
      [],
      review
    );
  }
  assert.deepEqual(
    triageDocumentGaps(
      head([
        "**Confidence**: Not available: Jev did not answer",
        "**Review**: Not required: x",
      ])
    ),
    []
  );
});

test("a missing, blank or malformed line is named", () => {
  const confidence =
    "**Confidence**: verdict 0.82, classification 0.7, path 0.6";
  assert.equal(triageDocumentGaps(head([])).length, 2);
  assert.equal(triageDocumentGaps(head([confidence])).length, 1);
  assert.equal(
    triageDocumentGaps(head(["**Review**: Pending critic"])).length,
    1
  );
  for (const bad of [
    "**Confidence**: high",
    "**Confidence**: verdict 1.5, classification 0.7, path 0.6",
    "**Confidence**: verdict 0.8, classification 0.7",
    "**Confidence**: ",
  ]) {
    assert.equal(
      triageDocumentGaps(head([bad, "**Review**: Pending critic"])).length,
      1,
      bad
    );
  }
  assert.equal(
    triageDocumentGaps(head([confidence, "**Review**: "])).length,
    1
  );
  assert.equal(
    triageDocumentGaps(head([confidence, "**Review**: Not required:"])).length,
    1
  );
});
