import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURES,
  featureForProject,
  isDependencyKey,
  isFeatureKey,
  LINEAR_PROJECT_FEATURES,
} from "./scope.js";

test("featureForProject", async (t) => {
  await t.test("resolves a mapped Linear project", () => {
    assert.equal(
      featureForProject("1ae59086-e924-42d1-b7ff-f9c750a2a7c9"),
      "cold_email"
    );
  });

  await t.test("fails closed on an unmapped project", () => {
    assert.equal(
      featureForProject("00000000-0000-0000-0000-000000000000"),
      null
    );
  });

  await t.test("fails closed on a missing project", () => {
    assert.equal(featureForProject(null), null);
    assert.equal(featureForProject(undefined), null);
  });

  await t.test("never guesses from a symptom or a name", () => {
    assert.equal(featureForProject("Cold Email Agent"), null);
    assert.equal(featureForProject("cold_email"), null);
  });
});

test("scope taxonomy", async (t) => {
  await t.test("every mapped project resolves to a known feature", () => {
    for (const feature of Object.values(LINEAR_PROJECT_FEATURES)) {
      assert.ok(isFeatureKey(feature), `${feature} is not a feature key`);
    }
  });

  await t.test("excludes Shopify Store Builder", () => {
    assert.equal(
      LINEAR_PROJECT_FEATURES["60b8e7f0-ebcb-46f4-ad69-9b3247c0545f"],
      undefined
    );
    assert.ok(!Object.keys(FEATURES).includes("shopify_store_builder"));
  });

  await t.test("carries Acquisity Agent as planned, not live", () => {
    assert.equal(FEATURES.acquisity_agent.lifecycle, "planned");
    assert.equal(FEATURES.cold_email.lifecycle, "live");
  });

  await t.test("has no generic shared scope", () => {
    assert.ok(!isFeatureKey("shared"));
  });
});

test("isDependencyKey", async (t) => {
  await t.test("accepts stable lowercase keys", () => {
    for (const key of ["instantly", "webhooks", "inngest", "billing"]) {
      assert.ok(isDependencyKey(key), key);
    }
  });

  await t.test("rejects free text, casing, and unbounded input", () => {
    for (const key of [
      "Instantly",
      "cold email",
      "a",
      "x".repeat(41),
      "kebab-case",
      "",
    ]) {
      assert.equal(isDependencyKey(key), false, key);
    }
  });
});
