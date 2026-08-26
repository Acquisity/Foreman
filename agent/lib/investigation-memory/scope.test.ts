import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEATURES,
  featureForCase,
  featureForProject,
  isDependencyKey,
  isFeatureKey,
  LINEAR_PROJECT_FEATURES,
  LIVE_FEATURE_KEYS,
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

  await t.test("fails closed on an inherited object property name", () => {
    for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
      assert.equal(featureForProject(name), null, name);
    }
  });

  await t.test("never guesses from a symptom or a name", () => {
    assert.equal(featureForProject("Cold Email Agent"), null);
    assert.equal(featureForProject("cold_email"), null);
  });
});

test("featureForCase", async (t) => {
  await t.test("lets a mapped project override the model's key", () => {
    assert.equal(
      featureForCase({
        linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
        primaryFeatureKey: "crm",
      }),
      "cold_email"
    );
  });

  await t.test("fails closed on an unmapped project, key or no key", () => {
    assert.equal(
      featureForCase({
        linearProjectId: "00000000-0000-0000-0000-000000000000",
        primaryFeatureKey: "crm",
      }),
      null
    );
  });

  await t.test("takes the model's live area only without a project", () => {
    assert.equal(featureForCase({ primaryFeatureKey: "crm" }), "crm");
    assert.equal(
      featureForCase({ linearProjectId: null, primaryFeatureKey: "crm" }),
      "crm"
    );
  });

  await t.test("refuses a planned area and an absent key", () => {
    assert.equal(
      featureForCase({ primaryFeatureKey: "acquisity_agent" }),
      null
    );
    assert.equal(featureForCase({}), null);
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

  await t.test("maps Domains & Inboxes to its own area, not cold email", () => {
    assert.equal(
      featureForProject("9f2e1f4a-f878-4481-96f8-3eb15f048390"),
      "domains_inboxes"
    );
    assert.equal(FEATURES.domains_inboxes.lifecycle, "live");
  });

  await t.test("carries Acquisity Agent as planned, not live", () => {
    assert.equal(FEATURES.acquisity_agent.lifecycle, "planned");
    assert.equal(FEATURES.cold_email.lifecycle, "live");
  });

  await t.test(
    "exposes exactly the six live areas for project-independent recall",
    () => {
      assert.deepEqual([...LIVE_FEATURE_KEYS].sort(), [
        "ai_sdr",
        "cold_email",
        "core_platform",
        "crm",
        "domains_inboxes",
        "website_builder",
      ]);
      assert.equal(LIVE_FEATURE_KEYS.includes("acquisity_agent"), false);
    }
  );

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
