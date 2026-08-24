import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLUSTER_MIN_REPORTS,
  DEFAULT_SEARCH_LIMIT,
  idempotencyKey,
  isConfigured,
  MAX_SEARCH_LIMIT,
} from "./store.js";

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
