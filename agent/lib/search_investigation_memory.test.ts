import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { LIVE_FEATURE_KEYS } from "#lib/investigation-memory/scope.js";
import searchInvestigationMemory from "../tools/search_investigation_memory.js";

const { inputSchema, outputSchema } = searchInvestigationMemory;
assert.ok(inputSchema instanceof z.ZodType);
assert.ok(outputSchema instanceof z.ZodType);

interface ParsedInput {
  dependencyKeys?: string[];
  limit: number;
  linearProjectId?: string;
  sourceIssueId?: string;
}

interface ParsedOutput {
  clusters?: Array<{ primaryFeatureKey: string }>;
  primaryFeatureKey?: string;
  searchedFeatureKeys?: string[];
}

test("search_investigation_memory accepts project-free Intercom claims", () => {
  const input = inputSchema.parse({
    component: "campaign scheduler",
    dependencyKeys: ["inngest"],
    provider: "instantly",
    text: "Campaigns remain queued after the visible scheduling error.",
  }) as ParsedInput;

  assert.equal(input.linearProjectId, undefined);
  assert.deepEqual(input.dependencyKeys, ["inngest"]);
  assert.equal(input.limit, 5);
});

test("project-free output identifies live areas and per-area clusters", () => {
  const output = outputSchema.parse({
    available: true,
    cases: [],
    clusters: [
      {
        distinctFeatures: 1,
        firstSeen: "2026-08-20T00:00:00.000Z",
        lastSeen: "2026-08-22T00:00:00.000Z",
        possibleWiderIncident: true,
        primaryFeatureKey: "cold_email",
        reports: 3,
        windowDays: 14,
      },
    ],
    searchedFeatureKeys: LIVE_FEATURE_KEYS,
  }) as ParsedOutput;

  assert.deepEqual(output.searchedFeatureKeys, LIVE_FEATURE_KEYS);
  assert.equal(output.clusters?.[0]?.primaryFeatureKey, "cold_email");
  assert.equal(output.primaryFeatureKey, undefined);
});

test("existing project-scoped input remains supported", () => {
  const input = inputSchema.parse({
    linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    sourceIssueId: "ENG-123",
  }) as ParsedInput;

  assert.equal(input.linearProjectId, "1ae59086-e924-42d1-b7ff-f9c750a2a7c9");
  assert.equal(input.sourceIssueId, "ENG-123");
});

test("project-free search remains denied to an unstamped session", async () => {
  const pending = searchInvestigationMemory.execute(
    {
      limit: 5,
      text: "Campaigns stay queued.",
      windowDays: 365,
    },
    {
      session: { auth: { current: null } },
    } as Parameters<typeof searchInvestigationMemory.execute>[1]
  );
  const result = await (pending as Promise<{
    available: boolean;
    reason?: string;
  }>);

  assert.equal(result.available, false);
  assert.ok((result.reason ?? "").includes("not authorized"));
});
