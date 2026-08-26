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
  const project = "1ae59086-e924-42d1-b7ff-f9c750a2a7c9";

  await t.test("resolves a Linear source only through its project", () => {
    assert.equal(
      featureForCase({
        linearProjectId: project,
        primaryFeatureKey: "crm",
        sourceIssueId: "ENG-1",
      }),
      "cold_email"
    );
  });

  await t.test("never lets a Linear source pick its own bucket", () => {
    // No project, a live key: the key must not stand in for the project.
    assert.equal(
      featureForCase({ primaryFeatureKey: "crm", sourceIssueId: "ENG-1" }),
      null
    );
    assert.equal(
      featureForCase({
        linearProjectId: "00000000-0000-0000-0000-000000000000",
        primaryFeatureKey: "crm",
        sourceIssueId: "ENG-1",
      }),
      null
    );
  });

  await t.test(
    "takes a ticketless source's live key and ignores any project",
    () => {
      for (const sourceIssueId of [
        "intercom:215475639279561",
        "slack:C0BCV1WBR42/1787771700.647079",
      ]) {
        assert.equal(
          featureForCase({ primaryFeatureKey: "crm", sourceIssueId }),
          "crm",
          sourceIssueId
        );
        assert.equal(
          featureForCase({
            linearProjectId: project,
            primaryFeatureKey: "crm",
            sourceIssueId,
          }),
          "crm",
          sourceIssueId
        );
      }
    }
  );

  await t.test(
    "refuses a planned area and an absent key on a ticketless source",
    () => {
      assert.equal(
        featureForCase({
          primaryFeatureKey: "acquisity_agent",
          sourceIssueId: "intercom:1",
        }),
        null
      );
      assert.equal(featureForCase({ sourceIssueId: "intercom:1" }), null);
    }
  );
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

  await t.test(
    "records the ENG Support project, not the SAN sandbox one",
    () => {
      assert.equal(
        featureForProject("4534deb2-6bbc-4e30-ad38-48963f414d14"),
        "support"
      );
      assert.equal(
        featureForProject("e3479f03-e840-4f72-864e-fc956c7934d6"),
        null
      );
      assert.equal(FEATURES.support.lifecycle, "live");
    }
  );

  await t.test("carries Acquisity Agent as planned, not live", () => {
    assert.equal(FEATURES.acquisity_agent.lifecycle, "planned");
    assert.equal(FEATURES.cold_email.lifecycle, "live");
  });

  await t.test(
    "exposes exactly the seven live areas for project-independent recall",
    () => {
      assert.deepEqual([...LIVE_FEATURE_KEYS].sort(), [
        "ai_sdr",
        "cold_email",
        "core_platform",
        "crm",
        "domains_inboxes",
        "support",
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
