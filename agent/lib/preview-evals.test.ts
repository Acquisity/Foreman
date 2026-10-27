import assert from "node:assert/strict";
import { test } from "node:test";
import { writesOnlyIssue } from "../../evals/preview/linear-triage.eval.js";

test("Executor Linear writes reject unknown destinations alongside a SAN literal", () => {
  const audit = (code: string) =>
    writesOnlyIssue(
      { input: { code }, toolName: "executor__execute" },
      "sandbox-id",
      "SAN-123"
    );

  assert.equal(
    audit('await tools.linear.save_issue({ id: "SAN-123", title: "Updated" })'),
    true
  );
  for (const destination of [
    "otherIssue",
    '"SAN-123" + suffix',
    "getIssue()",
  ]) {
    assert.equal(
      audit(
        `await tools.linear.save_issue({ id: "SAN-123" }); await tools.linear.save_comment({ issue: ${destination}, body: "Update" })`
      ),
      false,
      destination
    );
  }
});
