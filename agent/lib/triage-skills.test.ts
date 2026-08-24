import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageSkill = readFileSync(
  new URL("../skills/triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const intercomTriageSkill = readFileSync(
  new URL("../skills/intercom-triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const slackWordingSkill = readFileSync(
  new URL("../skills/slack-wording/SKILL.md", import.meta.url),
  "utf8"
);

test("Slack product triage master searches enforce the 30-day cutoff", () => {
  for (const skill of [triageSkill, intercomTriageSkill]) {
    assert.ok(skill.includes('createdAt: "-P30D"'));
    assert.ok(skill.includes("created exactly 30 days ago"));
    assert.ok(skill.includes("even by one second"));
    assert.ok(skill.includes("before comparing or attaching"));
    assert.ok(skill.includes("current") && skill.includes("blast-radius"));
    assert.ok(skill.includes("similarity"));
    assert.ok(skill.includes("evidence"));
    assert.ok(skill.includes("product-area"));
    assert.ok(skill.includes("duplicate"));
  }
});

test("Slack replies exclude internal investigation summaries", () => {
  for (const skill of [triageSkill, intercomTriageSkill]) {
    assert.ok(skill.includes("only") && skill.includes("requester-facing"));
    assert.ok(skill.includes("investigation summary"));
  }

  assert.ok(slackWordingSkill.includes("final post"));
  assert.ok(slackWordingSkill.includes("single-audience message"));
  assert.ok(slackWordingSkill.includes("only the forwardable requester reply"));
  assert.ok(slackWordingSkill.includes("Linear update report"));
  assert.ok(
    slackWordingSkill.includes("progress updates may be conversational")
  );
});
