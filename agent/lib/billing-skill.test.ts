import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const billingSkill = readFileSync(
  new URL("../skills/billing-triage/SKILL.md", import.meta.url),
  "utf8"
);

test("billing triage reads the complete Linear issue contract", () => {
  assert.ok(
    billingSkill.includes(
      "title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations"
    )
  );
});
