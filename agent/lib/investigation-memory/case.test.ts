import assert from "node:assert/strict";
import { test } from "node:test";
import { casePayloadSchema, forbiddenReason, searchText } from "./case.js";

const EMAIL_REASON = /email address/;
const UUID_REASON = /UUID/;
const RATE_LIMIT = /rate limit/;
const CODE_PATH = /sendCampaignBatch/;
const PROVIDER = /instantly/;

const payload = {
  affectedFeatureKeys: ["ai_sdr"],
  claim:
    "Campaign sends stopped after the sending window closed, and no bounce was recorded.",
  codePaths: ["packages/cold-email/src/send.ts sendCampaignBatch"],
  confidence: "high",
  dependencyKeys: ["instantly"],
  errorSignatures: ["InstantlyRateLimit: 429 on batch send"],
  evidenceRefs: ["sentry:4509912345", "inngest:01HZY0MK6R8V9QK2W3X4Y5Z6A7"],
  linearProjectId: "1ae59086-e924-42d1-b7ff-f9c750a2a7c9",
  rootCause:
    "The provider rate limit was hit and the retry schedule silently dropped the remaining batch.",
  ruledOut: ["Domain reputation", "Inbox disconnection"],
  sourceIssueId: "ENG-12345",
  sourceIssueUrl: "https://linear.app/acquisity/issue/ENG-12345/sends-stopped",
  symptoms: ["Campaign shows sending but no emails leave"],
};

test("forbiddenReason", async (t) => {
  await t.test("passes ordinary investigation prose", () => {
    assert.equal(forbiddenReason(payload.rootCause), null);
  });

  await t.test("rejects a customer email address", () => {
    assert.match(
      forbiddenReason("Reported by jane.doe@example.com") ?? "",
      EMAIL_REASON
    );
  });

  await t.test("rejects an organization or user id", () => {
    assert.match(
      forbiddenReason("org 3f8b1c2d-4e5f-4a6b-8c9d-0e1f2a3b4c5d stuck") ?? "",
      UUID_REASON
    );
  });

  await t.test("allows opaque vendor ids in evidence handles", () => {
    assert.equal(
      forbiddenReason("run 3f8b1c2d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", true),
      null
    );
  });

  await t.test("rejects credentials wherever they appear", () => {
    for (const value of [
      "sk_live_abcdef1234567890",
      "Authorization: Bearer abcdefghijklmnopqrstuvwx",
      "postgres://user:pw@host/db",
      "api_key = 8f2b91c0aa31",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    ]) {
      assert.notEqual(forbiddenReason(value, true), null, value);
    }
  });
});

test("casePayloadSchema", async (t) => {
  await t.test("accepts a sanitized case", () => {
    assert.equal(casePayloadSchema.safeParse(payload).success, true);
  });

  await t.test("rejects a case carrying customer identity", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      rootCause: `${payload.rootCause} Affected user was jane.doe@example.com.`,
    });
    assert.equal(result.success, false);
  });

  await t.test("rejects raw production rows past the length bound", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      rootCause: "x".repeat(1001),
    });
    assert.equal(result.success, false);
  });

  await t.test("bounds the number of symptoms", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      symptoms: Array.from({ length: 9 }, (_, index) => `symptom ${index}`),
    });
    assert.equal(result.success, false);
  });

  await t.test("rejects an unknown affected feature", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      affectedFeatureKeys: ["shared"],
    });
    assert.equal(result.success, false);
  });

  await t.test("takes no primary feature from model input", () => {
    const parsed = casePayloadSchema.parse({
      ...payload,
      primaryFeatureKey: "core_platform",
    });
    assert.ok(!("primaryFeatureKey" in parsed));
  });

  await t.test("defaults every optional list to empty", () => {
    const parsed = casePayloadSchema.parse({
      claim: payload.claim,
      confidence: "low",
      linearProjectId: payload.linearProjectId,
      rootCause: payload.rootCause,
      sourceIssueId: payload.sourceIssueId,
      sourceIssueUrl: payload.sourceIssueUrl,
    });
    assert.deepEqual(parsed.affectedFeatureKeys, []);
    assert.deepEqual(parsed.codePaths, []);
    assert.deepEqual(parsed.dependencyKeys, []);
    assert.deepEqual(parsed.errorSignatures, []);
    assert.deepEqual(parsed.evidenceRefs, []);
    assert.deepEqual(parsed.ruledOut, []);
    assert.deepEqual(parsed.symptoms, []);
  });

  await t.test("requires a counted date whenever a count is given", () => {
    for (const counts of [
      { affectedOrgCount: 3 },
      { affectedUserCount: 7 },
      { affectedOrgCount: 3, affectedUserCount: 7 },
    ]) {
      const result = casePayloadSchema.safeParse({ ...payload, ...counts });
      assert.equal(result.success, false, JSON.stringify(counts));
    }
  });

  await t.test("accepts counts carrying their counted date", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      affectedOrgCount: 3,
      affectedUserCount: 7,
      countedAt: "2026-08-23",
    });
    assert.equal(result.success, true);
  });

  await t.test("accepts a counted date on its own", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      countedAt: "2026-08-23",
    });
    assert.equal(result.success, true);
  });

  await t.test(
    "rejects a source URL carrying credentials in its authority",
    () => {
      for (const url of [
        "https://user:secret@linear.app/acquisity/issue/ENG-1/x",
        "https://user:sk_live_12345678@linear.app/acquisity/issue/ENG-1/x",
        "https://token@linear.app/acquisity/issue/ENG-1/x",
        "http://linear.app/acquisity/issue/ENG-1/x",
      ]) {
        assert.equal(
          casePayloadSchema.safeParse({ ...payload, sourceIssueUrl: url })
            .success,
          false,
          url
        );
      }
    }
  );

  await t.test("rejects a document URL carrying credentials", () => {
    assert.equal(
      casePayloadSchema.safeParse({
        ...payload,
        sourceDocumentUrl:
          "https://user:secret@linear.app/acquisity/document/x",
      }).success,
      false
    );
  });

  await t.test("rejects a double-encoded credential in a source URL", () => {
    for (const url of [
      "https://linear.app/acquisity/issue/ENG-1/x?token%253Dabcdefgh",
      "https://linear.app/acquisity/issue/ENG-1/x?token%25253Dabcdefgh",
      "https://linear.app/acquisity/issue/ENG-1/x?a=%2561pi_key%253Dabcdefgh",
    ]) {
      assert.equal(
        casePayloadSchema.safeParse({ ...payload, sourceIssueUrl: url })
          .success,
        false,
        url
      );
    }
  });

  await t.test("accepts ordinary Linear links", () => {
    const result = casePayloadSchema.safeParse({
      ...payload,
      sourceDocumentUrl:
        "https://linear.app/acquisity/document/triage-investigation-7ad9869c3488",
      sourceIssueUrl:
        "https://linear.app/acquisity/issue/ENG-12345/campaign-sends-stopped",
    });
    assert.equal(result.success, true);
  });

  await t.test("rejects a malformed Linear identifier", () => {
    assert.equal(
      casePayloadSchema.safeParse({ ...payload, sourceIssueId: "12345" })
        .success,
      false
    );
  });
});

test("searchText covers the fields retrieval matches on", () => {
  const text = searchText({
    claim: payload.claim,
    codePaths: payload.codePaths,
    component: "sending",
    errorSignatures: payload.errorSignatures,
    provider: "instantly",
    rootCause: payload.rootCause,
    symptoms: payload.symptoms,
  });
  assert.match(text, RATE_LIMIT);
  assert.match(text, CODE_PATH);
  assert.match(text, PROVIDER);
});
