import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageSkill = readFileSync(
  new URL("../skills/triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const triageReportingReference = readFileSync(
  new URL(
    "../skills/triage-investigate/references/reporting.md",
    import.meta.url
  ),
  "utf8"
);
const triageToolsReference = readFileSync(
  new URL("../skills/triage-investigate/references/tools.md", import.meta.url),
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

const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

test("shared triage exposes one seven-stage workflow with settled fact boundaries", () => {
  const stages = [
    "Stage 1: Establish the case",
    "Stage 2: Resolve customer identity once",
    "Stage 3: Check existing work and frame the investigation",
    "Stage 4: Investigate",
    "Stage 5: Decide handling",
    "Stage 6: Persist and route",
    "Stage 7: Finish the attended response and memory bookkeeping",
  ];

  let previousIndex = -1;
  for (const stage of stages) {
    const stageIndex = triageSkill.indexOf(`## ${stage}`);
    assert.ok(stageIndex > previousIndex);
    previousIndex = stageIndex;
  }

  assert.equal(triageSkill.match(/^## Stage \d:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Purpose:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Inputs:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Completion:/gmu)?.length, 7);
  assert.ok(triageSkill.includes("runtime's `intakeOnly` value as a fact"));
  assert.ok(triageSkill.includes("including `null`"));
  assert.ok(
    triageSkill.includes(
      "Reopen it only when genuinely new evidence conflicts with that result"
    )
  );
  assert.ok(
    triageSkill.includes(
      "without reopening trusted intake, project, identity, or completed evidence unless new conflicting evidence appears"
    )
  );
});

test("shared triage preserves every evidence lane and exact tool catalog", () => {
  const evidenceLanes = [
    "Search investigation memory",
    "Locate it in the code",
    "Check the data",
    "Background work",
    "Errors, crashes, stack traces",
    "Anything the other lanes do not carry",
    "Email delivery, bounces, spam placement",
    "Instantly workspace membership",
    "What the user actually did",
    "Deployment or edge failures",
    "The conversation behind the report",
  ];
  const toolCatalogs = [
    "Repository (root tools, no prefix)",
    "Investigation memory (root tools, no prefix)",
    "PlanetScale (`planetscale__`)",
    "Instantly (root tools, no prefix)",
    "Linear (`linear__`)",
    "Inngest (`inngest__`)",
    "Sentry (`sentry__`)",
    "Axiom (`axiom__`)",
    "PostHog (`posthog__`)",
    "Lucent (`lucent__`)",
    "Jam (`jam__`)",
    "Vercel (`vercel__`)",
    "Intercom (`intercom__`)",
    "Resend (`resend__`)",
    "Modem (`modem__`)",
  ];

  for (const lane of evidenceLanes) {
    assert.ok(triageSkill.includes(lane), lane);
  }
  for (const catalog of toolCatalogs) {
    assert.ok(triageToolsReference.includes(`## ${catalog}`), catalog);
  }
  assert.ok(triageSkill.includes("[references/tools.md](references/tools.md)"));
  assert.ok(
    triageSkill.includes("[references/reporting.md](references/reporting.md)")
  );
  assert.ok(triageReportingReference.includes("## Linear report template"));
  assert.ok(
    triageReportingReference.includes(
      "## Triage investigation document template"
    )
  );
  assert.ok(triageReportingReference.includes("## Master ticket template"));
});

test("shared triage preserves project-scoped memory and missing-project routing", () => {
  assert.ok(
    triageSkill.includes(
      "A ticket with no project has nothing to search. Record `Unavailable: no Linear project`"
    )
  );
  assert.ok(
    triageSkill.includes(
      "When the Linear project is `null` or unmapped, record no investigation-memory case and route to Aaron Fraga"
    )
  );
  assert.ok(
    triageSkill.includes(
      "PlanetScale is the production database and the only source of current production truth"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Historical memory is analogy only and cannot settle the verdict, duplicate, master, severity, or current blast radius"
    )
  );
});

test("shared triage stops unproven claims before classification or routing", () => {
  assert.ok(
    triageSkill.includes(
      "When the deciding confirmation is still missing, take the unproven branch and stop before classification"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Preserve the source ticket's current state, priority, and labels"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Do not create or attach a master, route engineering work, or record investigation memory"
    )
  );
  assert.ok(
    triageSkill.includes("Before stopping, run `Find the unblock` below")
  );
  assert.ok(
    triageSkill.includes(
      "action, owner, current status, and confirmation that it costs the customer neither data nor money"
    )
  );
  assert.ok(
    triageSkill.includes(
      "either the unproven branch has made the unblock explicit"
    )
  );
  assert.ok(triageReportingReference.includes("## Unproven branch reporting"));
  assert.ok(
    triageReportingReference.includes("`**Classification**: Not settled`")
  );
  assert.ok(
    triageReportingReference.includes(
      "Never use the master ticket template or create or attach a master for this branch"
    )
  );
});

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
