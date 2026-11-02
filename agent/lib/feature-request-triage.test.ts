import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JevAnswer } from "./jev.js";
import { resolveTriage, triageQuestions } from "./jev-decisions.js";
import { bugAnswers, pick, triageInput } from "./triage-fixtures.js";

const CLOSED = ["Canceled", "Done", "Duplicate"];
const FEATURE_PRECEDENCE =
  /new capability or a lifted limit.*Feature Request/su;

const split = (probabilities: Record<string, number>): JevAnswer => {
  const [choice] = Object.entries(probabilities).sort(
    (a, b) => b[1] - a[1]
  )[0] ?? [""];
  return { choice, probabilities, type: "choice" };
};

const request = (over: Record<string, JevAnswer> = {}) =>
  bugAnswers({
    area: pick("ai_sdr"),
    classification: pick("feature_request"),
    path: pick("Platform Limitation"),
    ...over,
  });

const MATCH = {
  duplicateCandidates: [
    { identifier: "ENG-15932", priority: 4, summary: "same ask", title: "t" },
  ],
};

describe("Feature Request is its own classification (ENG-15932, ENG-17138)", () => {
  it("offers Jev Feature Request as a classification and no yes/no limit question", () => {
    const questions = triageQuestions(triageInput());
    const { classification } = questions;
    assert.ok(classification.type === "choice");
    assert.ok(Object.hasOwn(classification.criteria, "feature_request"));
    assert.equal(questions.wants_limit_lifted, undefined);
    assert.match(classification.instructions, FEATURE_PRECEDENCE);
  });

  it("parks an unapproved Feature Request in Backlog with James and Needs approval, whatever path Jev picked", () => {
    for (const path of Object.keys({
      "Backlog/low-impact": 1,
      "Engineering Todo": 1,
      "Platform Limitation": 1,
      "Resolved by triage": 1,
      "Support/Financial": 1,
      "Support/Product follow-up": 1,
      "User Error": 1,
    })) {
      const decision = resolveTriage(
        triageInput(),
        request({ path: pick(path) })
      );
      assert.ok(decision.outcome === "route", path);
      assert.equal(decision.classification, "Feature Request", path);
      assert.equal(decision.path, "Feature Request", path);
      assert.equal(decision.route.state, "Backlog", path);
      assert.equal(decision.route.assignee, "James Keeble", path);
      assert.equal(decision.approval, "needed", path);
      assert.ok(decision.route.addLabels.includes("Feature Request"), path);
      assert.ok(decision.route.addLabels.includes("Needs approval"), path);
    }
  });

  it("keeps an unapproved Feature Request that matches another report open in Backlog, related to the match instead of closing as Duplicate (ENG-17138)", () => {
    const decision = resolveTriage(
      triageInput(MATCH),
      request({ duplicate_0: pick("same_outcome", 0.95) })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.path, "Feature Request");
    assert.equal(decision.route.state, "Backlog");
    assert.equal(decision.route.duplicateOf, undefined);
    assert.equal(decision.route.inheritAssigneeFrom, undefined);
    assert.equal(decision.route.relatedTo, "ENG-15932");
    assert.equal(decision.route.assignee, "James Keeble");
    assert.equal(decision.needsCriticReview, false);
  });

  it("replays ENG-15932: a text-notification ask stays open in Backlog for James instead of closing Done as a platform limitation", () => {
    const decision = resolveTriage(
      triageInput({
        blastRadius: undefined,
        claim:
          "The rep wants a text notification when a lead replies; the CRM only sends email notifications.",
        codePath: undefined,
        evidence:
          "Notification settings offer email and in-app channels only; no SMS channel exists in the notification code.",
        regression: undefined,
      }),
      request({ path: pick("Platform Limitation") })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.route.state, "Backlog");
    assert.equal(decision.route.assignee, "James Keeble");
    assert.deepEqual(
      ["Feature Request", "Needs approval"].filter((label) =>
        decision.route.addLabels.includes(label)
      ),
      ["Feature Request", "Needs approval"]
    );
  });

  it("classes a provider limit the customer wants lifted as a Feature Request, not a closed Platform Limitation", () => {
    const decision = resolveTriage(
      triageInput({
        claim: "The customer wants SMS notifications, which Twilio limits.",
      }),
      request({
        classification: split({
          feature_request: 0.55,
          platform_limitation: 0.45,
        }),
        path: pick("Platform Limitation"),
      })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.classification, "Feature Request");
    assert.equal(decision.route.state, "Backlog");
  });
});

describe("fail open below 0.7 on an explanation", () => {
  for (const choice of ["platform_limitation", "user_error"] as const) {
    const path = choice === "user_error" ? "User Error" : "Platform Limitation";
    it(`turns a ${path} at 0.69 into a Feature Request that stays open`, () => {
      const decision = resolveTriage(
        triageInput(),
        bugAnswers({
          classification: split({ [choice]: 0.69, feature_request: 0.31 }),
          path: pick(path),
        })
      );
      assert.ok(decision.outcome === "route");
      assert.equal(decision.classification, "Feature Request");
      assert.equal(CLOSED.includes(decision.route.state), false);
      assert.ok(decision.route.addLabels.includes("Needs approval"));
    });

    it(`closes a ${path} at 0.7 as Canceled`, () => {
      const decision = resolveTriage(
        triageInput(),
        bugAnswers({
          classification: split({ [choice]: 0.7, feature_request: 0.3 }),
          path: pick(path),
        })
      );
      assert.ok(decision.outcome === "route");
      assert.equal(decision.classification, path);
      assert.equal(decision.route.state, "Canceled");
      assert.ok(decision.route.addLabels.includes("Needs grouping"));
    });
  }

  it("leaves an explanation below the classification bar open as unproven, never closed", () => {
    const decision = resolveTriage(
      triageInput(),
      bugAnswers({
        classification: split({
          bug: 0.2,
          platform_limitation: 0.4,
          user_error: 0.4,
        }),
        path: pick("Platform Limitation"),
      })
    );
    assert.equal(decision.outcome, "unproven");
  });

  it("still closes a clear how-to User Error Canceled when nothing matches, so how-to noise stays out of Backlog", () => {
    const decision = resolveTriage(
      triageInput(),
      bugAnswers({
        classification: pick("user_error", 0.9),
        path: pick("User Error"),
      })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.route.state, "Canceled");
    assert.ok(decision.route.addLabels.includes("Needs grouping"));
    assert.equal(decision.route.addLabels.includes("Feature Request"), false);
  });
});

describe("person decisions survive retriage", () => {
  it("keeps approved routing for a ticket labelled Approved even when retriage calls it a Platform Limitation", () => {
    const decision = resolveTriage(
      triageInput({ ticketLabels: ["Approved", "Feature Request"] }),
      bugAnswers({
        area: pick("ai_sdr"),
        classification: pick("platform_limitation", 0.95),
        path: pick("Platform Limitation"),
      })
    );
    assert.ok(decision.outcome === "route");
    assert.equal(decision.classification, "Feature Request");
    assert.equal(decision.approval, "approved");
    assert.equal(decision.path, "Engineering Todo");
    assert.equal(decision.route.state, "Todo");
    assert.equal(decision.route.assignee, "James Keeble");
    assert.equal(
      decision.route.removeLabels?.includes("Approved") ?? false,
      false
    );
  });

  it("keeps a Declined ticket Canceled on retriage, with no developer", () => {
    for (const classification of ["feature_request", "platform_limitation"]) {
      const decision = resolveTriage(
        triageInput({ ticketLabels: ["Declined", "Feature Request"] }),
        bugAnswers({
          classification: pick(classification),
          path: pick("Engineering Todo"),
        })
      );
      assert.ok(decision.outcome === "route", classification);
      assert.equal(decision.path, "Declined", classification);
      assert.equal(decision.route.state, "Canceled", classification);
      assert.equal(decision.route.assignee, undefined, classification);
    }
  });
});
