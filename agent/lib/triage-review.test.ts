import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { JevAnswer } from "./jev.js";
import {
  resolveTriage,
  type TriageInput,
  triageQuestions,
} from "./jev-decisions.js";
import { SUPPORT_OWNER } from "./owner-map.js";
import { bugAnswers, pick, triageInput, yes } from "./triage-fixtures.js";
import { ownershipRoute, resolveOwnership } from "./triage-ownership.js";
import { gateInboxError } from "./triage-review.js";

const REVIEW_SOURCE = readFileSync(
  new URL("./triage-review.ts", import.meta.url),
  "utf8"
);

const NOW = new Date("2026-10-23T10:00:00.000Z");
const LANE_REASON = /could not run/u;
const CUSTOMER_SAW_REASON = /customer saw a failure/u;
const BILLING_CHECK_MISSING = /billing check/u;
const CLASSIFICATION_MISSING = /classification/u;
const PATH_MISSING = /handling path/u;
const UNPROVEN_REASON = /unproven/u;
const PERSON_REASON = /person/u;

const billingFacts = (
  over: Partial<NonNullable<TriageInput["billingFacts"]>> = {}
): NonNullable<TriageInput["billingFacts"]> => ({
  checkedAt: "2026-10-23T08:00:00.000Z",
  domainsLive: true,
  organizationId: "org-1",
  paymentsFailing: false,
  source: "read_billing_account and the domain order status",
  subscriptionPaid: true,
  ...over,
});

const inboxInput = (over: Partial<TriageInput> = {}): TriageInput =>
  triageInput({
    billingFacts: billingFacts(),
    duplicateCandidates: [
      { identifier: "ENG-40", priority: 2, summary: "same", title: "t" },
    ],
    organizationId: "org-1",
    ...over,
  });

const inboxAnswers = (over: Record<string, JevAnswer> = {}) =>
  bugAnswers({
    duplicate_0: pick("same_outcome", 0.9),
    inbox_error: yes(),
    ...over,
  });

const userErrorAnswers = (over: Record<string, JevAnswer> = {}) =>
  bugAnswers({
    classification: pick("user_error"),
    path: pick("User Error"),
    ...over,
  });

test("a User Error with a lane that could not run goes to the second check", () => {
  for (const input of [
    triageInput({ unavailableLanes: ["Sentry"] }),
    triageInput({ evidence: "Inngest lane. Could not run: no access." }),
  ]) {
    const decision = resolveTriage(input, userErrorAnswers());
    assert.ok(decision.outcome === "route");
    assert.equal(decision.route.state, "Canceled");
    assert.equal(decision.needsCriticReview, true);
    assert.equal(decision.review.required, true);
    assert.equal(decision.review.kind, "user_error");
    assert.match(decision.review.reason, LANE_REASON);
  }
});

test("a User Error explaining away a failure the customer saw goes to the second check", () => {
  const decision = resolveTriage(
    triageInput(),
    userErrorAnswers({ customer_saw_failure: yes() })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.needsCriticReview, true);
  assert.match(decision.review.reason, CUSTOMER_SAW_REASON);
});

test("a User Error with every lane run and no failure seen closes with a stated reason", () => {
  const decision = resolveTriage(triageInput(), userErrorAnswers());
  assert.ok(decision.outcome === "route");
  assert.equal(decision.needsCriticReview, false);
  assert.equal(decision.review.required, false);
  assert.equal(decision.review.kind, null);
  assert.ok(decision.review.reason.length > 0);
});

test("a Platform Limitation goes to the second check, whatever path carries it", () => {
  for (const path of ["Platform Limitation", "Engineering Todo"]) {
    const decision = resolveTriage(
      triageInput(),
      bugAnswers({
        classification: pick("platform_limitation"),
        path: pick(path),
      })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.needsCriticReview, true);
    assert.equal(decision.review.kind, "platform_limitation");
    assert.equal(decision.hotlane, undefined);
  }
});

test("a Duplicate goes to the second check and carries no hotlane route", () => {
  const decision = resolveTriage(
    triageInput({
      duplicateCandidates: [
        { identifier: "ENG-9", priority: 2, summary: "same", title: "t" },
      ],
    }),
    bugAnswers({ duplicate_0: pick("same_outcome", 0.85) })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.review.kind, "duplicate");
  assert.equal(decision.hotlane, undefined);
});

test("a User Error that leaves the ticket open for a person is not a closure", () => {
  const decision = resolveTriage(
    triageInput({ unavailableLanes: ["Sentry"] }),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Support/Product follow-up"),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.review.required, false);
  assert.match(decision.review.reason, PERSON_REASON);
});

test("an inbox error whose domains expired at the supplier is billing, not a code bug or a duplicate", () => {
  const decision = resolveTriage(
    inboxInput({ billingFacts: billingFacts({ domainsLive: false }) }),
    inboxAnswers(),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Support/Financial");
  assert.equal(decision.route.duplicateOf, undefined);
  assert.equal(decision.route.inheritAssigneeFrom, undefined);
  assert.equal(decision.route.project, "Support");
  assert.equal(decision.route.assignee, "Aaron Fraga");
  assert.equal(decision.route.state, "Todo");
  assert.equal(decision.needsCriticReview, true);
  assert.equal(decision.review.kind, "billing_inbox");
  assert.deepEqual(decision.billingCheck, {
    failures: ["The domains are not live at the supplier."],
    outcome: "failed",
  });
  assert.equal(decision.hotlane, undefined);
});

test("an unpaid subscription or failing payments also make an inbox error billing", () => {
  for (const over of [{ subscriptionPaid: false }, { paymentsFailing: true }]) {
    const decision = resolveTriage(
      inboxInput({ billingFacts: billingFacts(over) }),
      inboxAnswers({ duplicate_0: pick("not_relevant") }),
      NOW
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.path, "Support/Financial");
    assert.equal(decision.billingCheck?.outcome, "failed");
  }
});

test("an inbox error with no usable billing facts cannot be a Bug or a duplicate", () => {
  const cases: [string, Partial<TriageInput>][] = [
    ["missing", { billingFacts: undefined }],
    [
      "stale",
      { billingFacts: billingFacts({ checkedAt: "2026-10-20T08:00:00.000Z" }) },
    ],
    ["undated", { billingFacts: billingFacts({ checkedAt: "yesterday" }) }],
    [
      "future",
      { billingFacts: billingFacts({ checkedAt: "2026-10-24T08:00:00.000Z" }) },
    ],
    [
      "another workspace",
      { billingFacts: billingFacts({ organizationId: "org-2" }) },
    ],
    ["no pinned workspace", { organizationId: undefined }],
    ["domains unknown", { billingFacts: billingFacts({ domainsLive: null }) }],
    [
      "payments unknown",
      { billingFacts: billingFacts({ paymentsFailing: null }) },
    ],
  ];
  for (const [name, over] of cases) {
    const duplicate = resolveTriage(inboxInput(over), inboxAnswers(), NOW);
    assert.equal(duplicate.outcome, "unproven", name);
    assert.ok(duplicate.outcome === "unproven");
    assert.match(duplicate.missing.join(" "), BILLING_CHECK_MISSING, name);
    const bug = resolveTriage(
      inboxInput(over),
      inboxAnswers({ duplicate_0: pick("not_relevant") }),
      NOW
    );
    assert.equal(bug.outcome, "unproven", name);
  }
});

test("a known failure outranks an unknown fact", () => {
  const decision = resolveTriage(
    inboxInput({
      billingFacts: billingFacts({
        domainsLive: null,
        subscriptionPaid: false,
      }),
    }),
    inboxAnswers(),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Support/Financial");
});

test("an inbox error that passes the billing check is still a Bug and still reviewed", () => {
  const decision = resolveTriage(
    inboxInput(),
    inboxAnswers({ duplicate_0: pick("not_relevant") }),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.classification, "Bug");
  assert.deepEqual(decision.billingCheck, { failures: [], outcome: "passed" });
  assert.equal(decision.review.kind, "bug");
});

test("the billing check is not asked of a ticket that is not an inbox error", () => {
  const decision = resolveTriage(
    triageInput({ duplicateCandidates: [] }),
    bugAnswers(),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.billingCheck, undefined);
});

test("an inbox error classed as a user error is not held for the billing facts", () => {
  const decision = resolveTriage(
    triageInput(),
    userErrorAnswers({ inbox_error: yes() }),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.billingCheck, undefined);
});

test("a 0.4-confidence user error ends unproven, not Done", () => {
  const decision = resolveTriage(
    triageInput({ unavailableLanes: ["Sentry"] }),
    userErrorAnswers({ classification: pick("user_error", 0.4) })
  );
  assert.equal(decision.outcome, "unproven");
  assert.ok(decision.outcome === "unproven");
  assert.match(decision.missing.join(" "), CLASSIFICATION_MISSING);
  assert.equal(decision.confidence.classification, 0.4);
  assert.equal(decision.review.required, false);
});

test("a 0.4-confidence path ends unproven, but a found duplicate does not need one", () => {
  const unclear = resolveTriage(
    triageInput(),
    bugAnswers({ path: pick("Engineering Todo", 0.4) })
  );
  assert.ok(unclear.outcome === "unproven");
  assert.match(unclear.missing.join(" "), PATH_MISSING);

  const duplicate = resolveTriage(
    triageInput({
      duplicateCandidates: [
        { identifier: "ENG-9", summary: "same", title: "t" },
      ],
    }),
    bugAnswers({
      duplicate_0: pick("same_outcome", 0.85),
      path: pick("Engineering Todo", 0.2),
    })
  );
  assert.ok(duplicate.outcome === "route");
  assert.equal(duplicate.path, "Duplicate");
  assert.equal(duplicate.confidence.path, 0.85);
});

test("the bar sits exactly at 0.6 for classification and path", () => {
  for (const [over, outcome] of [
    [{ classification: pick("bug", 0.6) }, "route"],
    [{ classification: pick("bug", 0.59) }, "unproven"],
    [{ path: pick("Engineering Todo", 0.6) }, "route"],
    [{ path: pick("Engineering Todo", 0.59) }, "unproven"],
  ] as const) {
    assert.equal(
      resolveTriage(triageInput(), bugAnswers(over)).outcome,
      outcome
    );
  }
});

test("every outcome carries a confidence for the verdict, classification and path", () => {
  const routed = resolveTriage(triageInput(), bugAnswers());
  assert.deepEqual(routed.confidence, {
    classification: 0.9,
    path: 0.9,
    verdict: 0.9,
  });
  const unproven = resolveTriage(
    triageInput(),
    bugAnswers({ verdict: pick("unproven", 0.8) })
  );
  assert.ok(unproven.outcome === "unproven");
  assert.equal(unproven.confidence.verdict, 0.8);
  assert.equal(unproven.review.required, false);
  assert.match(unproven.review.reason, UNPROVEN_REASON);
});

test("triage asks about customer-seen failures and inbox errors", () => {
  const questions = triageQuestions(triageInput());
  assert.equal(questions.customer_saw_failure.type, "boolean");
  assert.equal(questions.inbox_error.type, "boolean");
});

test("the billing gate returns a disposition and the owner map builds the billing route", () => {
  const input = inboxInput({
    billingFacts: billingFacts({ domainsLive: false }),
  });
  const answers = inboxAnswers();
  const gate = gateInboxError({
    answers,
    classification: "Bug",
    duplicate: undefined,
    input,
    notes: [],
    now: NOW,
    signal: 0.5,
  });
  assert.deepEqual(gate, {
    billingCheck: {
      failures: ["The domains are not live at the supplier."],
      outcome: "failed",
    },
    kind: "billing",
  });
  const decision = resolveTriage(input, answers, NOW);
  assert.ok(decision.outcome === "route");
  const ownership = resolveOwnership({
    answers,
    bar: 0.5,
    billing: true,
    classification: "Platform Limitation",
    closed: false,
    duplicate: false,
    input,
    notes: [],
    path: "Support/Financial",
    project: null,
  });
  assert.equal(decision.assignee, SUPPORT_OWNER);
  assert.deepEqual(decision.route, {
    ...ownershipRoute(ownership, input.sourceLabels),
    priority: decision.route.priority,
    project: "Support",
    state: "Todo",
  });
  assert.ok(!REVIEW_SOURCE.includes(SUPPORT_OWNER));
});

test("a billed inbox error stays a support follow-up even when a lifted limit is wanted", () => {
  const decision = resolveTriage(
    inboxInput({ billingFacts: billingFacts({ domainsLive: false }) }),
    inboxAnswers({ wants_limit_lifted: yes() }),
    NOW
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.approval, "not-applicable");
  assert.equal(decision.route.assignee, SUPPORT_OWNER);
  assert.ok(!decision.route.addLabels.includes("Needs approval"));
});

test("a close where nothing changed is Canceled, so Done always means a change was made", () => {
  const userError = resolveTriage(
    triageInput(),
    bugAnswers({ classification: pick("user_error"), path: pick("User Error") })
  );
  assert.ok(userError.outcome === "route");
  assert.equal(userError.route.state, "Canceled");
  const limit = resolveTriage(
    triageInput(),
    bugAnswers({
      classification: pick("platform_limitation"),
      path: pick("Platform Limitation"),
    })
  );
  assert.ok(limit.outcome === "route");
  assert.equal(limit.route.state, "Canceled");
  const resolved = resolveTriage(
    triageInput(),
    bugAnswers({
      classification: pick("user_error"),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(resolved.outcome === "route");
  assert.equal(resolved.route.state, "Done");
});
