import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERNAL_ORGS } from "./internal-orgs.js";
import { candidateRowSchema, parseExcludedOrgs } from "./widget-candidates.js";

const TEST_ORG = "22222222-2222-4222-8222-222222222222";

test("excluded test workspaces are parsed strictly", () => {
  const excluded = parseExcludedOrgs(` ${TEST_ORG.toUpperCase()} ,`);
  assert.ok(excluded.has(TEST_ORG));
  // The scorer and capability-gap filing share one internal list.
  assert.deepEqual([...parseExcludedOrgs(undefined)], [...INTERNAL_ORGS]);
  assert.throws(() => parseExcludedOrgs("acme-test"));
});

test("rows parse from Postgres shapes and an unknown outcome reads as none", () => {
  const parsed = candidateRowSchema.parse({
    completed_at: "2026-10-05 12:00:00.123456+00",
    conversation_id: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-10-05 11:59:58+00",
    decision: null,
    findings: null,
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "11111111-1111-4111-8111-111111111111",
    outcome: { unexpected: true },
    question: "How do I connect my Gmail inbox?",
    scope: { organizationSlug: "acme" },
    session_id: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(parsed.outcome, null);
  assert.equal(parsed.completed_at.toISOString(), "2026-10-05T12:00:00.123Z");
});
