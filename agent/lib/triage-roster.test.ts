import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageHandlingSkill = readFileSync(
  new URL("../skills/triage-handling/SKILL.md", import.meta.url),
  "utf8"
);
const triageRosterReference = readFileSync(
  new URL("../skills/triage-handling/references/roster.md", import.meta.url),
  "utf8"
);

test("triage handling points at the roster and says who may take a ticket", () => {
  assert.ok(triageHandlingSkill.includes("### Area-routing roster"));
  assert.ok(
    triageHandlingSkill.includes("[references/roster.md](references/roster.md)")
  );
  assert.ok(triageHandlingSkill.includes("`Approved`"));
  assert.ok(triageHandlingSkill.includes("`Needs approval`"));
  assert.ok(triageRosterReference.includes("refuses any assignee"));
  assert.equal(triageRosterReference.includes("@"), false);
});
