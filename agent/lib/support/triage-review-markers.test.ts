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

test("a reviewed decision that adjudication left unproven completes on its Adjudicated line", () => {
  const untouched = { ...closed, priority: null, status: "Backlog" };
  assert.doesNotThrow(() =>
    assertTriageOutputs(
      untouched,
      doc(
        "Not settled",
        `Adjudicated ${pin}: CHALLENGE; the duplicate target was ruled out, so the claim stays unproven`
      ),
      linked
    )
  );
  for (const review of [
    `Approved ${pin}`,
    "Adjudicated 2026-10-27T10:00:00.000Z",
    "Pending critic",
  ]) {
    assert.throws(
      () => assertTriageOutputs(untouched, doc("Not settled", review), linked),
      SupportRefusal,
      review
    );
  }
});

test("a Bug whose fix is on main but not live completes with the area owner and no master", () => {
  const fix = "f".repeat(40);
  const pending = {
    assignee: "Anthony Adewale",
    labels: [
      "intercom-sourced",
      "Customer reported",
      "Bug",
      "Area: Cold Email",
    ],
    parentId: null,
    priority: { value: 3 },
    project: "Cold Email Core",
    status: "Todo",
  };
  const content = (result: string) => ({
    content: `# Triage investigation\n**Classification**: Bug\n**Handling path**: Support/Product follow-up\n**Review**: Approved ${pin}\n\n## Regression check\n**Result**: ${result}\n`,
    url,
  });
  for (const result of [
    `fixed on main, not deployed yet, by ${fix}`,
    `fixed on main, deploy status unknown, by ${fix}`,
  ]) {
    assert.doesNotThrow(
      () => assertTriageOutputs(pending, content(result), linked),
      result
    );
  }
  assert.throws(
    () => assertTriageOutputs(pending, content(`introduced by ${fix}`), linked),
    SupportRefusal
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        { ...pending, assignee: null },
        content(`fixed on main, not deployed yet, by ${fix}`),
        linked
      ),
    SupportRefusal
  );
});
