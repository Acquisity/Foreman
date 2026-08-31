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
const ROSTER_BULLET_PATTERN = /^- ([^:]+): (.+?) \(`([^`]+)`\)(?:, (.+))?$/u;

test("triage handling keeps the complete area-routing roster contract", () => {
  assert.ok(triageHandlingSkill.includes("### Area-routing roster"));
  assert.ok(
    triageHandlingSkill.includes("[references/roster.md](references/roster.md)")
  );
  const expected = {
    "Acquisity Agent (AI Consultant)": {
      email: "jil.patel@acquisity.ai",
      owner: "Jil Patel",
      qualifier: null,
    },
    "AI SDR": {
      email: "koppany.kondricz@acquisity.ai",
      owner: "Koppany Kondricz",
      qualifier: null,
    },
    "Anything else": {
      email: "aaron.fraga@acquisity.ai",
      owner: "Aaron Fraga",
      qualifier: null,
    },
    "Cold Email": {
      email: "anthony.adewale@acquisity.ai",
      owner: "Anthony Adewale",
      qualifier: null,
    },
    "Core Platform": {
      email: "anuj.bhatt@acquisity.ai",
      owner: "Anuj Bhatt",
      qualifier: "fallback James Keeble",
    },
    CRM: {
      email: "ebubeker.rexha@acquisity.ai",
      owner: "Ebubeker Rexha",
      qualifier: null,
    },
    Support: {
      email: "aaron.fraga@acquisity.ai",
      owner: "Aaron Fraga",
      qualifier: "never an engineer",
    },
    "Website Builder": {
      email: "james.keeble@aiacquisition.com",
      owner: "James Keeble",
      qualifier: null,
    },
  };
  const bullets = triageRosterReference
    .split("\n")
    .filter((line) => line.startsWith("- "));
  const parsed = new Map<
    string,
    { email: string; owner: string; qualifier: string | null }
  >();
  for (const bullet of bullets) {
    const match = ROSTER_BULLET_PATTERN.exec(bullet);
    assert.ok(match, bullet);
    parsed.set(match[1], {
      email: match[3],
      owner: match[2],
      qualifier: match[4] ?? null,
    });
  }
  assert.equal(bullets.length, Object.keys(expected).length);
  assert.deepEqual(Object.fromEntries(parsed), expected);
});
