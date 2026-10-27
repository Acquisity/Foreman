import assert from "node:assert/strict";
import { test } from "node:test";
import { triageDocumentGaps } from "../triage-document.js";
import { SupportRefusal } from "./errors.js";
import { assertTriageOutputs } from "./triage-completion.js";

const url = "https://linear.app/acquisity/document/investigation-1";
const linked = [{ body: `Closed. [Triage investigation](${url})` }];
const closed = {
  assignee: null,
  labels: ["intercom-sourced", "Customer reported"],
  parentId: null,
  priority: { value: 4 },
  project: null,
  status: "Canceled",
};
const doc = (classification: string, review: string) => ({
  content: `# Triage investigation\n**Classification**: ${classification}\n**Confidence**: verdict 0.90, classification 0.80, path 0.80\n**Review**: ${review}`,
  url,
});
const pin = `2026-10-27T10:00:00.000Z at ${"a".repeat(40)}`;

test("an unreviewed outcome completes with the reason the document gate asks for, and with the old literal", () => {
  for (const classification of ["User Error", "Platform Limitation"]) {
    for (const review of [
      "Not required: every evidence lane ran and the report names no failure the customer saw",
      "Not required",
    ]) {
      const document = doc(classification, review);
      assert.doesNotThrow(
        () => assertTriageOutputs(closed, document, linked),
        review
      );
    }
    const reasoned = doc(classification, "Not required: the ticket stays open");
    assert.deepEqual(triageDocumentGaps(reasoned.content), []);
  }
  assert.doesNotThrow(() =>
    assertTriageOutputs(
      { ...closed, priority: null, status: "Backlog" },
      doc("Not settled", "Not required: the ticket stays open as unproven"),
      linked
    )
  );
  assert.throws(
    () =>
      assertTriageOutputs(closed, doc("User Error", "Not required:"), linked),
    SupportRefusal
  );
});

test("a ticket the critic blocked completes once the support owner holds it, with its fields untouched", () => {
  const untouched = {
    labels: ["intercom-sourced", "Customer reported"],
    priority: null,
    relations: null,
    status: "Backlog",
  };
  const blocked = doc(
    "Bug",
    `Blocked ${pin}: CHALLENGE twice; the master match is not proven`
  );
  const told = [
    {
      body: "The checks could not confirm the result; Aaron is bringing in the owner.",
    },
  ];
  assert.doesNotThrow(() =>
    assertTriageOutputs(
      { ...untouched, assignee: "Aaron Fraga" },
      blocked,
      told
    )
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        { ...untouched, assignee: "Anthony Adewale" },
        blocked,
        told
      ),
    SupportRefusal
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        { ...untouched, assignee: "Aaron Fraga" },
        doc("Bug", "Blocked twice"),
        told
      ),
    SupportRefusal
  );
});
