import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const billingSkill = readFileSync(
  new URL("../skills/billing-triage/SKILL.md", import.meta.url),
  "utf8"
);

test("billing triage reads the complete Linear issue contract", () => {
  const issueRead = billingSkill.indexOf("2. Step 1 issue read:");
  const identityGate = billingSkill.indexOf("3. Identity gate:");
  const stepOne = billingSkill.indexOf("## Step 1: Read the Linear issue");
  const stepTwo = billingSkill.indexOf("## Never move money", stepOne);

  assert.ok(issueRead >= 0);
  assert.ok(identityGate > issueRead);
  assert.ok(stepOne >= 0);
  assert.ok(stepTwo > stepOne);

  const issueReadSection = billingSkill.slice(stepOne, stepTwo);
  assert.ok(
    issueReadSection.includes(
      "title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations"
    )
  );
});
