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
const customerBugDiagnosisSkill = readFileSync(
  new URL("../skills/customer-bug-diagnosis/SKILL.md", import.meta.url),
  "utf8"
);
const triageCriticSkill = readFileSync(
  new URL("../skills/triage-critic/SKILL.md", import.meta.url),
  "utf8"
);
const incidentHotlaneSkill = readFileSync(
  new URL("../skills/incident-hotlane/SKILL.md", import.meta.url),
  "utf8"
);
const engineeringHandoffSkill = readFileSync(
  new URL("../skills/engineering-handoff/SKILL.md", import.meta.url),
  "utf8"
);

const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

test("Slack product triage master searches enforce the 30-day cutoff", () => {
  const skills = [
    {
      end: "\n   Do not filter this search by label.",
      skill: triageSkill,
      start: "1. Search for an existing master on four axes:",
    },
    {
      end: "\n3. Create one customer-report issue",
      skill: intercomTriageSkill,
      start: "2. Search current Linear masters no further than 30 days back.",
    },
  ];

  for (const { end, skill, start } of skills) {
    const masterSearchInstruction = extractInstruction(skill, start, end);
    assert.ok(masterSearchInstruction.includes("linear__list_issues"));
    assert.ok(
      masterSearchInstruction.includes("8eaf95ab-56ac-4490-8253-f6a96793dc40")
    );
    assert.ok(masterSearchInstruction.includes('createdAt: "-P30D"'));
    assert.ok(masterSearchInstruction.includes("limit: 250"));
    assert.ok(
      masterSearchInstruction.includes(
        "repeat the identical filtered query with the returned `cursor`, accumulating candidates from every page until `hasNextPage` is false"
      )
    );
    assert.ok(skill.includes("created exactly 30 days ago"));
    assert.ok(skill.includes("even by one second"));
    assert.ok(skill.includes("selecting a candidate as the current master"));
    assert.ok(skill.includes("current-master selection and parent attachment"));
    assert.ok(skill.includes("may be related for history"));
    assert.ok(skill.includes("never reused as the parent"));
    assert.ok(!skill.includes("before comparing or attaching anything"));
    assert.ok(skill.includes("current") && skill.includes("blast-radius"));
    assert.ok(skill.includes("similarity"));
    assert.ok(skill.includes("evidence"));
    assert.ok(skill.includes("product-area"));
    assert.ok(skill.includes("duplicate"));
  }
});

test("shared triage preserves unbounded master lookup outside Slack intake", () => {
  const masterSelection = extractInstruction(
    triageSkill,
    "### When the root cause warrants action",
    "### Area-routing roster"
  );

  assert.ok(masterSelection.includes("intake-only Slack workflow"));
  assert.ok(masterSelection.includes("including a Linear Agent Session"));
  assert.ok(masterSelection.includes("do not pass a `createdAt` filter"));
  assert.ok(
    masterSelection.includes(
      "consider matching masters regardless of creation date"
    )
  );
  assert.ok(masterSelection.includes("Outside that Slack workflow"));
  assert.ok(masterSelection.includes("do not apply the recency cutoff"));
  assert.ok(masterSelection.includes("In other contexts"));
  assert.ok(masterSelection.includes("eligibility has no recency cutoff"));
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

test("both intake routers share diagnosis and the bounded critic gate", () => {
  for (const skill of [triageSkill, intercomTriageSkill]) {
    const memorySearch = skill.indexOf("call `search_investigation_memory`");
    const diagnosis = skill.indexOf("Load `customer-bug-diagnosis`");
    const packet = skill.indexOf("create_triage_review_packet", diagnosis);
    const critic = skill.indexOf("call the declared `triage-critic`");
    const attestation = skill.indexOf(
      "call `read_triage_review_verdict`",
      critic
    );
    const finalWrites = Math.max(
      skill.indexOf("completed structural writes"),
      skill.indexOf("all applicable Linear writes and readback")
    );
    const memoryWrite = skill.lastIndexOf("call `record_investigation_case`");

    assert.ok(memorySearch >= 0);
    assert.ok(diagnosis > memorySearch);
    assert.ok(packet > diagnosis);
    assert.ok(critic > packet);
    assert.ok(attestation > critic);
    assert.ok(finalWrites > attestation);
    assert.ok(memoryWrite > finalWrites);
    assert.ok(skill.includes("one targeted"));
    assert.ok(skill.includes("exact current evidence revision"));
    assert.ok(skill.includes("read_triage_review_verdict"));
    assert.ok(skill.includes("opaque"));
  }
});

test("shared triage skills preserve the causal and impact contracts", () => {
  assert.ok(customerBugDiagnosisSkill.includes("PRODUCTION_FORENSICS"));
  assert.ok(customerBugDiagnosisSkill.includes("COULD_NOT_RUN"));
  assert.ok(customerBugDiagnosisSkill.includes("regression_seam"));
  assert.ok(triageCriticSkill.includes("same investigation reach"));
  assert.ok(triageCriticSkill.includes("one targeted recheck"));
  assert.ok(incidentHotlaneSkill.includes("even for one workspace"));
  assert.ok(engineeringHandoffSkill.includes("Match by cause, not symptom"));
  assert.ok(engineeringHandoffSkill.includes("Read back"));
  assert.ok(engineeringHandoffSkill.includes("reserve_triage_master"));
  assert.ok(
    engineeringHandoffSkill.includes("complete_triage_master_reservation")
  );
  assert.ok(
    engineeringHandoffSkill.includes(
      "Only the transaction that atomically reserves"
    )
  );
  assert.ok(
    customerBugDiagnosisSkill.includes(
      "Independent investigations of the same cause"
    )
  );
});

test("unproven and urgent-human outcomes cannot enter structural Bug writes", () => {
  assert.ok(
    triageSkill.includes(
      "Never label, route, parent, prioritize, announce, or record it as a settled Bug"
    )
  );
  assert.ok(
    incidentHotlaneSkill.includes("terminal for automated finalization")
  );
  for (const skill of [triageSkill, intercomTriageSkill]) {
    assert.ok(skill.includes("NEEDS_HUMAN_URGENT"));
    assert.ok(
      skill.includes("provisional confirmation-in-progress escalation")
    );
  }
});

test("engineering handoff binds the final candidate set and idempotent relations", () => {
  assert.ok(
    engineeringHandoffSkill.includes("exact eligible candidate identifiers")
  );
  assert.ok(
    engineeringHandoffSkill.includes(
      "obtain approval for a new packet revision"
    )
  );
  assert.ok(
    engineeringHandoffSkill.includes("when that exact relation is absent")
  );
  assert.ok(engineeringHandoffSkill.includes("successful idempotent state"));
});

test("engineering-handoff exclusively owns the structural write state machine", () => {
  for (const skill of [triageSkill, intercomTriageSkill]) {
    assert.ok(skill.includes("exclusively owns"));
    assert.ok(skill.includes("Do not restate or bypass"));
  }
  assert.ok(
    engineeringHandoffSkill.includes("If an existing master owns the cause")
  );
  assert.ok(
    engineeringHandoffSkill.includes(
      "If no eligible existing master owns the cause"
    )
  );
});
