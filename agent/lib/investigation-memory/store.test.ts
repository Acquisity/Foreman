import assert from "node:assert/strict";
import { test } from "node:test";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { casePayloadSchema, caseProjectionSchema } from "./case.js";
import {
  type CaseRow,
  CLUSTER_MIN_REPORTS,
  correctCase,
  DEFAULT_SEARCH_LIMIT,
  featureClusterSignalsFromCounts,
  GLOBAL_CLUSTER_SQL,
  idempotencyKey,
  isConfigured,
  MAX_SEARCH_LIMIT,
  projectCase,
  recordCase,
} from "./store.js";

const writePayload = casePayloadSchema.parse({
  claim: "Campaign sends stopped.",
  confidence: "high",
  linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
  rootCause: "The scheduler dropped the dispatch transition.",
  sourceIssueId: "ENG-123",
  sourceIssueUrl: "https://linear.app/acquisity/issue/ENG-123/example",
});

const fakeDatabase = (
  query: (statement: string, params?: unknown[]) => Promise<unknown>
): NeonQueryFunction<false, false> =>
  ({ query }) as unknown as NeonQueryFunction<false, false>;

test("case projection converts Neon Date values to plain JSON", () => {
  const row: CaseRow = {
    affected_feature_keys: [],
    affected_org_count: 3,
    affected_user_count: null,
    claim: "Campaign analytics stopped updating.",
    classification: "bug",
    component: "campaign analytics",
    confidence: "high",
    counted_at: new Date("2026-08-24T00:00:00.000Z"),
    created_at: new Date("2026-08-24T14:49:12.000Z"),
    dependency_keys: [],
    evidence_refs: [],
    id: "case-1",
    observed_from: new Date("2026-08-20T12:00:00.000Z"),
    observed_to: null,
    primary_feature_key: "cold_email",
    provider: null,
    resolution: null,
    root_cause: "The analytics projection stopped consuming events.",
    source_document_url: null,
    source_issue_id: "ENG-1",
    source_issue_url: "https://linear.app/acquisity/issue/ENG-1/example",
    supersedes_case_id: null,
  };

  const projection = projectCase(row, "cold_email");

  assert.equal(projection.countedAt, "2026-08-24");
  assert.equal(projection.recordedAt, "2026-08-24T14:49:12.000Z");
  assert.deepEqual(caseProjectionSchema.parse(projection), projection);
});

test("idempotencyKey", async (t) => {
  await t.test(
    "is stable for the same conclusion, so a replay is a no-op",
    () => {
      assert.equal(
        idempotencyKey("ENG-1", "bug", "The retry schedule dropped the batch."),
        idempotencyKey("ENG-1", "bug", "The retry schedule dropped the batch.")
      );
    }
  );

  await t.test("changes when the conclusion changes", () => {
    assert.notEqual(
      idempotencyKey("ENG-1", "bug", "The retry schedule dropped the batch."),
      idempotencyKey(
        "ENG-1",
        "user_error",
        "The retry schedule dropped the batch."
      )
    );
  });

  await t.test("changes when the root cause changes", () => {
    assert.notEqual(
      idempotencyKey("ENG-1", "bug", "The retry schedule dropped the batch."),
      idempotencyKey("ENG-1", "bug", "The sending window was closed.")
    );
  });

  await t.test("does not collide across tickets", () => {
    assert.notEqual(
      idempotencyKey("ENG-1", "bug", "Same cause."),
      idempotencyKey("ENG-2", "bug", "Same cause.")
    );
  });

  await t.test(
    "allows a corrected conclusion to return to an earlier answer",
    () => {
      const firstA = idempotencyKey("ENG-1", "bug", "Conclusion A");
      const correctionB = idempotencyKey(
        "ENG-1",
        "platform_limitation",
        "Conclusion B",
        "case-a-1"
      );
      const secondA = idempotencyKey(
        "ENG-1",
        "bug",
        "Conclusion A",
        "case-b-1"
      );

      assert.notEqual(firstA, secondA);
      assert.notEqual(correctionB, secondA);
      assert.equal(
        secondA,
        idempotencyKey("ENG-1", "bug", "Conclusion A", "case-b-1")
      );
    }
  );

  await t.test(
    "keeps correction metadata separate from root-cause text",
    () => {
      assert.notEqual(
        idempotencyKey("ENG-1", "bug", "Conclusion A|supersedes:case-b-1"),
        idempotencyKey("ENG-1", "bug", "Conclusion A", "case-b-1")
      );
    }
  );
});

test("retrieval bounds", async (t) => {
  await t.test("hands the model a small default and a hard ceiling", () => {
    assert.equal(DEFAULT_SEARCH_LIMIT, 5);
    assert.equal(MAX_SEARCH_LIMIT, 10);
    assert.ok(DEFAULT_SEARCH_LIMIT <= MAX_SEARCH_LIMIT);
  });

  await t.test("holds the wider-incident threshold at three reports", () => {
    // The contract is three independent tickets. Asserting the exact figure
    // is the point: a weaker threshold would quietly turn coincidences into
    // possible-incident signals.
    assert.equal(CLUSTER_MIN_REPORTS, 3);
  });

  await t.test("keeps project-free incident signals isolated per area", () => {
    assert.ok(GLOBAL_CLUSTER_SQL.includes("count(DISTINCT source_issue_id)"));
    assert.ok(GLOBAL_CLUSTER_SQL.includes("GROUP BY primary_feature_key"));

    const signals = featureClusterSignalsFromCounts([
      {
        distinctFeatures: 1,
        firstSeen: "2026-08-20T00:00:00.000Z",
        lastSeen: "2026-08-22T00:00:00.000Z",
        primaryFeatureKey: "cold_email",
        reports: 3,
      },
      {
        distinctFeatures: 1,
        firstSeen: "2026-08-21T00:00:00.000Z",
        lastSeen: "2026-08-22T00:00:00.000Z",
        primaryFeatureKey: "crm",
        reports: 2,
      },
    ]);

    assert.equal(signals.length, 2);
    assert.deepEqual(
      signals.map((signal) => ({
        area: signal.primaryFeatureKey,
        possibleWiderIncident: signal.possibleWiderIncident,
        reports: signal.reports,
      })),
      [
        {
          area: "cold_email",
          possibleWiderIncident: true,
          reports: 3,
        },
        { area: "crm", possibleWiderIncident: false, reports: 2 },
      ]
    );
  });
});

test("isConfigured reports the store as unavailable when unset", () => {
  const previous = process.env.FOREMAN_MEMORY_DATABASE_URL;
  process.env.FOREMAN_MEMORY_DATABASE_URL = "";
  assert.equal(isConfigured(), false);
  process.env.FOREMAN_MEMORY_DATABASE_URL = "postgres://example";
  assert.equal(isConfigured(), true);
  if (previous === undefined) {
    process.env.FOREMAN_MEMORY_DATABASE_URL = undefined;
    delete process.env.FOREMAN_MEMORY_DATABASE_URL;
  } else {
    process.env.FOREMAN_MEMORY_DATABASE_URL = previous;
  }
});

test("record authorization is claimed only after replay and active-case checks", async () => {
  let claims = 0;
  const authorizeWrite = () => {
    claims += 1;
    return Promise.resolve(false);
  };
  const replay = await recordCase("cold_email", writePayload, "bug", {
    authorizeWrite,
    database: fakeDatabase(() => Promise.resolve([{ id: "case-replay" }])),
  });
  assert.equal(replay.created, false);
  if (replay.created) {
    assert.fail("A replay must not create a case.");
  }
  assert.equal(replay.reason, "already_recorded");
  assert.equal(claims, 0);

  const active = await recordCase("cold_email", writePayload, "bug", {
    authorizeWrite,
    database: fakeDatabase((statement) =>
      Promise.resolve(
        statement.includes("status = 'active'")
          ? [{ id: "case-active", revision: 1 }]
          : []
      )
    ),
  });
  assert.equal(active.created, false);
  if (active.created) {
    assert.fail("An existing active case must prevent a write.");
  }
  assert.equal(active.reason, "active_case_exists");
  assert.equal(claims, 0);

  const statements: string[] = [];
  const denied = await recordCase("cold_email", writePayload, "bug", {
    authorizeWrite,
    database: fakeDatabase((statement) => {
      statements.push(statement);
      return Promise.resolve([]);
    }),
  });
  assert.equal(denied.created, false);
  if (denied.created) {
    assert.fail("Denied authorization must prevent a write.");
  }
  assert.equal(denied.reason, "authorization_failed");
  assert.equal(claims, 1);
  assert.equal(
    statements.some((statement) => statement.includes("INSERT")),
    false
  );
});

test("correction authorization is claimed only after predecessor validation", async () => {
  let claims = 0;
  const authorizeWrite = () => {
    claims += 1;
    return Promise.resolve(false);
  };
  const missing = await correctCase(
    "cold_email",
    writePayload,
    "bug",
    "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    "New evidence changed the conclusion.",
    {
      authorizeWrite,
      database: fakeDatabase(() => Promise.resolve([])),
    }
  );
  assert.equal(missing.created, false);
  if (missing.created) {
    assert.fail("A missing predecessor must prevent a correction.");
  }
  assert.equal(missing.reason, "prior_case_not_active");
  assert.equal(claims, 0);

  const statements: string[] = [];
  const denied = await correctCase(
    "cold_email",
    writePayload,
    "bug",
    "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
    "New evidence changed the conclusion.",
    {
      authorizeWrite,
      database: fakeDatabase((statement) => {
        statements.push(statement);
        return Promise.resolve(
          statement.startsWith("SELECT id, revision, source_issue_id, status")
            ? [
                {
                  id: "0ae59086-e924-42d1-b7ff-f9c750a2a7c9",
                  revision: 1,
                  source_issue_id: "ENG-123",
                  status: "active",
                },
              ]
            : []
        );
      }),
    }
  );
  assert.equal(denied.created, false);
  if (denied.created) {
    assert.fail("Denied authorization must prevent a correction.");
  }
  assert.equal(denied.reason, "authorization_failed");
  assert.equal(claims, 1);
  assert.equal(
    statements.some((statement) => statement.includes("UPDATE")),
    false
  );
  assert.equal(
    statements.some((statement) => statement.includes("INSERT")),
    false
  );
});
