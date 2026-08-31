import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const agentRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalPath = fileURLToPath(
  new URL("./slack-intake.ts", import.meta.url)
);
const triageHandlingSkill = readFileSync(
  new URL("../skills/triage-handling/SKILL.md", import.meta.url),
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

const collectPolicySources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectPolicySources(path) : [path];
  });

const POINTER_PATTERN =
  /(?:canonical final-post (?:rule|stamp)|final-post rule lives only in `slack-intake\.ts`)/iu;
const SEMANTIC_RESTATEMENT_PATTERNS = [
  /\bonly\b.*\brequester-facing\b|\brequester-facing\b.*\bonly\b/iu,
  /\bfinal (?:assistant )?(?:message|post)\b.*\brequester-facing\b|\brequester-facing\b.*\bfinal (?:assistant )?(?:message|post)\b/iu,
  /\battended surface\b.*\brequester-facing\b/iu,
  /\bsingle-audience\b/iu,
  /\b(?:internal investigation summary|action log|proof of work)\b.*\b(?:Slack|reply|post|message)\b|\b(?:Slack|reply|post|message)\b.*\b(?:internal investigation summary|action log|proof of work)\b/iu,
];

const extractInstruction = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, start);
  assert.ok(endIndex > startIndex, end);
  return source.slice(startIndex, endIndex);
};

test("final Slack-post policy is authored only in slack-intake", () => {
  const policySources = collectPolicySources(agentRoot).filter(
    (path) =>
      path !== canonicalPath &&
      (path.endsWith(".md") || path.endsWith(".ts")) &&
      !path.endsWith(".test.ts")
  );
  const offenders: string[] = [];

  for (const path of policySources) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (POINTER_PATTERN.test(line)) {
        continue;
      }
      if (SEMANTIC_RESTATEMENT_PATTERNS.some((pattern) => pattern.test(line))) {
        offenders.push(`${relative(agentRoot, path)}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("Slack-facing skills defer to the canonical channel stamp", () => {
  const reply = extractInstruction(
    triageHandlingSkill,
    "### Slack-facing reply",
    "### Record the investigation in memory"
  );
  assert.ok(reply.includes("check whose lane"));
  assert.ok(reply.includes("`slack-intake.ts`"));
  assert.ok(triageHandlingSkill.includes("canonical final-post stamp"));
  assert.ok(intercomTriageSkill.includes("canonical final-post rule"));
  assert.ok(intercomTriageSkill.includes("Slack channel boundary"));
  assert.ok(slackWordingSkill.includes("canonical final-post rule"));
  assert.ok(slackWordingSkill.includes("Slack channel boundary"));
  assert.ok(slackWordingSkill.includes("do not restate or replace it here"));
});
