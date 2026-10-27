import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { JevAnswer } from "../jev.js";
import { resolveTriage, type TriageInput } from "../jev-decisions.js";
import { triageLabelSchema } from "./schema.js";

const labels = triageLabelSchema
  .array()
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../evals/triage/labels/train.json", import.meta.url),
        "utf8"
      )
    )
  );

const pick = (choice: string, confidence = 0.9): JevAnswer => ({
  choice,
  probabilities: { [choice]: confidence },
  type: "choice",
});
const yes = (): JevAnswer => ({ probability: 0.9, type: "boolean" });
const no = (): JevAnswer => ({ probability: 0.1, type: "boolean" });

const CLASSIFICATION_KEYS: Record<string, string> = {
  Bug: "bug",
  "Platform Limitation": "platform_limitation",
  "User Error": "user_error",
};

const input = (duplicate: boolean): TriageInput => ({
  blastRadius: { countedAt: "2026-10-01", orgs: 1, query: "q", users: 1 },
  claim: "c",
  codePath: { commit: "a".repeat(40), file: "f.ts", function: "fn" },
  duplicateCandidates: duplicate
    ? [{ identifier: "ENG-1", summary: "s", title: "t" }]
    : [],
  evidence: "every lane ran",
  identifier: "ENG-2",
  projects: [{ name: "CRM" }],
  rootCauseLabels: [],
  sourceLabels: [],
});

const answers = (
  classification: string,
  path: string,
  duplicate: boolean
): Record<string, JevAnswer> => ({
  classification: pick(CLASSIFICATION_KEYS[classification]),
  customer_saw_failure: no(),
  data_loss_or_security: no(),
  direct_evidence: yes(),
  impact: {
    probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
    score: 1,
    type: "score",
  },
  inbox_error: no(),
  incident: pick("standard"),
  incident_impact: pick("MATERIALLY_IMPAIRED"),
  money_blocker: no(),
  path: pick(path),
  project: pick("CRM"),
  verdict: pick("supported"),
  wants_limit_lifted: no(),
  ...(duplicate ? { duplicate_0: pick("same_outcome") } : {}),
});

const decided = labels.filter(
  (label) =>
    !label.insufficient &&
    label.verdict === "route" &&
    label.classification !== null &&
    label.path !== null &&
    label.classification in CLASSIFICATION_KEYS
);

const reviewedBefore = (classification: string, path: string) =>
  classification === "Bug" && path !== "Duplicate";

test("the second check reaches every labelled duplicate and platform limitation, which the Bug-only rule never did", (t) => {
  let before = 0;
  let after = 0;
  let duplicates = 0;
  let limits = 0;
  let userErrors = 0;
  for (const label of decided) {
    const classification = label.classification as string;
    const path = label.path as string;
    const duplicate = path === "Duplicate";
    const decision = resolveTriage(
      input(duplicate),
      answers(classification, path, duplicate)
    );
    assert.equal(decision.outcome, "route", label.id);
    assert.ok(decision.outcome === "route");
    const wasReviewed = reviewedBefore(classification, path);
    before += Number(wasReviewed);
    after += Number(decision.needsCriticReview);
    if (wasReviewed) {
      assert.equal(decision.needsCriticReview, true, label.id);
    }
    if (duplicate) {
      duplicates += 1;
      assert.equal(wasReviewed, false, label.id);
      assert.equal(decision.needsCriticReview, true, label.id);
    }
    if (classification === "Platform Limitation") {
      limits += 1;
      assert.equal(wasReviewed, false, label.id);
      assert.equal(decision.needsCriticReview, true, label.id);
    }
    if (classification === "User Error") {
      userErrors += 1;
    }
  }
  assert.ok(after > before);
  assert.ok(duplicates > 0 && limits > 0);
  t.diagnostic(
    `${decided.length} labelled train cases with a decided class and path: reviewed before ${before}, after ${after}; ${duplicates} duplicates and ${limits} platform limitations newly covered; ${userErrors} user errors covered only with a lane gap or a failure the customer saw`
  );
});
