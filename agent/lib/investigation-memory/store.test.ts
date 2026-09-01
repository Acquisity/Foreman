import assert from "node:assert/strict";
import { test } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { caseProjectionSchema } from "./case.js";
import {
  type CaseRow,
  CLUSTER_MIN_REPORTS,
  DEFAULT_SEARCH_LIMIT,
  featureClusterSignalsFromCounts,
  GLOBAL_CLUSTER_SQL,
  idempotencyKey,
  isConfigured,
  MAX_SEARCH_LIMIT,
  MEMORY_QUERY_TIMEOUT_MS,
  projectCase,
  searchCasesGlobally,
} from "./store.js";

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

  await t.test("keeps global incident signals isolated per area", () => {
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

test("every memory query carries a fresh deadline", async () => {
  const previous = process.env.FOREMAN_MEMORY_DATABASE_URL;
  process.env.FOREMAN_MEMORY_DATABASE_URL =
    "postgres://user:pw@memory.example/db";
  const signals: (AbortSignal | undefined)[] = [];
  const previousFetch = neonConfig.fetchFunction;
  neonConfig.fetchFunction = (
    _url: unknown,
    init: { signal?: AbortSignal }
  ) => {
    signals.push(init.signal);
    return Promise.reject(new Error("upstream refused"));
  };
  try {
    await assert.rejects(searchCasesGlobally({ text: "reset emails" }));
    // A second operation must not reuse the first deadline: a cached client
    // would hand every later query an already-fired signal.
    await assert.rejects(searchCasesGlobally({ text: "reset emails" }));
  } finally {
    neonConfig.fetchFunction = previousFetch;
    if (previous === undefined) {
      delete process.env.FOREMAN_MEMORY_DATABASE_URL;
    } else {
      process.env.FOREMAN_MEMORY_DATABASE_URL = previous;
    }
  }
  assert.ok(signals.length >= 2);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
  assert.notEqual(signals[0], signals.at(-1));
  assert.equal(MEMORY_QUERY_TIMEOUT_MS, 15_000);
});
