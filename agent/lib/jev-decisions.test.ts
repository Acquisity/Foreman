import assert from "node:assert/strict";
import { test } from "node:test";
import { askJev, type JevAnswer } from "./jev.js";
import {
  type BillingInput,
  billingQuestions,
  decideFollowUp,
  decidePriorWork,
  followUpText,
  resolveBilling,
  resolveFollowUp,
  resolvePriorWork,
  resolveTriage,
  type TriageInput,
  triageQuestions,
} from "./jev-decisions.js";
import {
  checkGrounding,
  resolveGrounding,
  splitClaims,
} from "./jev-grounding.js";

const yes = (probability = 0.9): JevAnswer => ({
  probability,
  type: "boolean",
});
const no = (): JevAnswer => ({ probability: 0.1, type: "boolean" });
const pick = (choice: string, confidence = 0.9): JevAnswer => ({
  choice,
  probabilities: { [choice]: confidence },
  type: "choice",
});
const band = (probabilities: Record<string, number>): JevAnswer => ({
  probabilities,
  score: 0,
  type: "score",
});

const triageInput = (over: Partial<TriageInput> = {}): TriageInput => ({
  blastRadius: {
    countedAt: "2026-09-25",
    orgs: 3,
    query: "select count(*)",
    users: 4,
  },
  claim: "Replies stopped arriving.",
  codePath: {
    commit: "a".repeat(40),
    file: "webhook.ts",
    function: "handleReply",
  },
  duplicateCandidates: [],
  evidence: "Inngest run failed at step parse.",
  identifier: "ENG-1",
  projects: [{ name: "AI SDR Core" }],
  rootCauseLabels: [],
  sourceLabels: ["Customer reported"],
  ...over,
});

const bugAnswers = (
  over: Record<string, JevAnswer> = {}
): Record<string, JevAnswer> => ({
  classification: pick("bug"),
  data_loss_or_security: no(),
  direct_evidence: yes(),
  impact: band({ "0": 0.05, "1": 0.8, "2": 0.1, "3": 0.05 }),
  incident: pick("standard"),
  incident_impact: pick("MATERIALLY_IMPAIRED"),
  money_blocker: no(),
  path: pick("Engineering Todo"),
  project: pick("AI SDR Core"),
  verdict: pick("supported"),
  wants_limit_lifted: no(),
  ...over,
});

test("a supported Bug with the full bar routes to the project and asks for review", () => {
  const decision = resolveTriage(triageInput(), bugAnswers());
  assert.equal(decision.outcome, "route");
  assert.ok(decision.outcome === "route");
  assert.equal(decision.classification, "Bug");
  assert.equal(decision.needsCriticReview, true);
  assert.equal(decision.assignee, "area owner");
  assert.deepEqual(decision.route, {
    addLabels: ["Customer reported", "Bug"],
    priority: 3,
    project: "AI SDR Core",
    state: "Todo",
  });
});

test("an unproven or unsure verdict stops before classification", () => {
  for (const verdict of [pick("unproven"), pick("supported", 0.4)]) {
    const decision = resolveTriage(triageInput(), bugAnswers({ verdict }));
    assert.equal(decision.outcome, "unproven");
  }
});

test("a Bug without a counted blast radius or code path is not a Bug yet", () => {
  const decision = resolveTriage(
    triageInput({ blastRadius: undefined, codePath: undefined }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "unproven");
  assert.equal(decision.missing.length, 2);
});

test("a near-certain same-outcome candidate makes it a duplicate that inherits", () => {
  const input = triageInput({
    duplicateCandidates: [
      { identifier: "ENG-9", priority: 2, summary: "same", title: "t" },
    ],
  });
  const decision = resolveTriage(
    input,
    bugAnswers({ duplicate_0: pick("same_outcome", 0.85) })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Duplicate");
  assert.equal(decision.needsCriticReview, false);
  assert.equal(decision.route.state, "Duplicate");
  assert.equal(decision.route.priority, 2);
  assert.equal(decision.route.duplicateOf, "ENG-9");
  assert.equal(decision.route.inheritAssigneeFrom, "ENG-9");
});

test("a weak same-outcome match is not a duplicate", () => {
  const input = triageInput({
    duplicateCandidates: [{ identifier: "ENG-9", summary: "s", title: "t" }],
  });
  const decision = resolveTriage(
    input,
    bugAnswers({ duplicate_0: pick("same_outcome", 0.7) })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.path, "Engineering Todo");
});

test("data loss is Urgent and a money blocker is at least High", () => {
  const urgent = resolveTriage(
    triageInput(),
    bugAnswers({ data_loss_or_security: yes() })
  );
  assert.ok(urgent.outcome === "route");
  assert.equal(urgent.route.priority, 1);

  const money = resolveTriage(
    triageInput(),
    bugAnswers({
      classification: pick("user_error"),
      money_blocker: yes(),
      path: pick("Resolved by triage"),
    })
  );
  assert.ok(money.outcome === "route");
  assert.equal(money.route.priority, 2);
  assert.equal(money.route.state, "Done");
});

test("between adjacent bands the higher one wins and is flagged", () => {
  const decision = resolveTriage(
    triageInput(),
    bugAnswers({ impact: band({ "1": 0.5, "2": 0.45, "3": 0.05 }) })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.route.priority, 2);
  assert.equal(decision.notes.length, 1);
});

test("an unsettled project leaves it unset and routes to Aaron", () => {
  const decision = resolveTriage(
    triageInput(),
    bugAnswers({ project: pick("undetermined") })
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.assignee, "Aaron Fraga");
  assert.equal(decision.route.project, undefined);
  assert.equal(decision.route.assignee, "Aaron Fraga");
});

test("a sandbox ticket always routes to Aaron", () => {
  const decision = resolveTriage(
    triageInput({ identifier: "SAN-4" }),
    bugAnswers()
  );
  assert.ok(decision.outcome === "route");
  assert.equal(decision.route.assignee, "Aaron Fraga");
  assert.equal(decision.route.project, "AI SDR Core");
});

test("a platform limitation the customer wants lifted is a Low feature request", () => {
  const decision = resolveTriage(
    triageInput({ rootCauseLabels: ["Provider limit"] }),
    bugAnswers({
      classification: pick("platform_limitation"),
      path: pick("Platform Limitation"),
      root_cause_label: pick("Provider limit"),
      wants_limit_lifted: yes(),
    })
  );
  assert.ok(decision.outcome === "route");
  assert.deepEqual(decision.route.addLabels, [
    "Customer reported",
    "Feature Request",
    "Provider limit",
  ]);
  assert.equal(decision.route.priority, 4);
  assert.equal(decision.route.state, "Done");
});

test("triage asks every question, including one per duplicate candidate", () => {
  const questions = triageQuestions(
    triageInput({
      duplicateCandidates: [
        { identifier: "ENG-2", summary: "s", title: "t" },
        { identifier: "ENG-3", summary: "s", title: "t" },
      ],
      rootCauseLabels: ["Provider limit"],
    })
  );
  assert.ok("duplicate_0" in questions && "duplicate_1" in questions);
  assert.ok("root_cause_label" in questions);
  const { project } = questions;
  assert.ok(project.type === "choice");
  assert.ok(Object.hasOwn(project.criteria, "undetermined"));
});

const billingInput = (over: Partial<BillingInput> = {}): BillingInput => ({
  approvalQuote: "Aaron approved a refund of the May charge.",
  bucket: "refund",
  evidence: "Stripe ch_1 $49 on 2026-05-01 after cancel on 2026-04-28.",
  sourceLabels: ["Internal reported"],
  ...over,
});

const billingAnswers = (
  over: Record<string, JevAnswer> = {}
): Record<string, JevAnswer> => {
  const answers: Record<string, JevAnswer> = {
    active_blocker: yes(),
    discretion: pick("justified"),
  };
  for (const key of Object.keys(billingQuestions())) {
    if (key.startsWith("check_")) {
      answers[key] = yes();
    }
  }
  return { ...answers, ...over };
};

test("a fully confirmed, approved refund is justified and routes to Support", () => {
  const decision = resolveBilling(billingInput(), billingAnswers());
  assert.equal(decision.discretion, "justified");
  assert.deepEqual(decision.route, {
    addLabels: ["Refund", "Internal reported"],
    assignee: "Aaron Fraga",
    priority: 2,
    project: "Support",
    state: "Todo",
  });
});

test("billing is needs-human without approval, with a gap, or when unsure", () => {
  assert.equal(
    resolveBilling(billingInput({ approvalQuote: null }), billingAnswers())
      .discretion,
    "needs-human"
  );
  const gap = resolveBilling(
    billingInput(),
    billingAnswers({ check_amount_from_primary_data: no() })
  );
  assert.equal(gap.discretion, "needs-human");
  assert.equal(gap.unconfirmed.length, 1);
  assert.equal(
    resolveBilling(
      billingInput(),
      billingAnswers({ discretion: pick("not_justified", 0.5) })
    ).discretion,
    "needs-human"
  );
});

test("a confident not-justified verdict stands and a non-blocker is Medium", () => {
  const decision = resolveBilling(
    billingInput({ bucket: "stripe_credit" }),
    billingAnswers({
      active_blocker: no(),
      discretion: pick("not_justified"),
    })
  );
  assert.equal(decision.discretion, "not justified");
  assert.equal(decision.route.priority, 3);
  assert.deepEqual(decision.route.addLabels, ["Credits", "Internal reported"]);
});

const reply = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

test("askJev sends one TypeSafe-only gateway request and returns the answers", async () => {
  let sent: { body: string; url: string } | undefined;
  const answers = await askJev(
    {
      kind: {
        criteria: { money: "m", product: "p" },
        instructions: "?",
        type: "choice",
      },
    },
    { report: "x" },
    {
      fetch: (url, init) => {
        sent = { body: String(init.body), url };
        return reply({
          answers: {
            kind: {
              choice: "money",
              probabilities: { money: 0.9, product: 0.1 },
              type: "choice",
            },
          },
          model: "typesafe-ai/jev",
        });
      },
      token: "t",
    }
  );
  assert.equal(sent?.url, "https://ai-gateway.vercel.sh/v1/evaluate");
  const body = JSON.parse(sent?.body ?? "{}");
  assert.equal(body.model, "typesafe-ai/jev");
  assert.deepEqual(body.providerOptions, {
    gateway: { only: ["typesafe-ai"] },
  });
  assert.equal(answers.kind?.type, "choice");
});

test("askJev refuses an answer off the menu, a missing answer, or a bad status", async () => {
  const question = {
    kind: {
      criteria: { money: "m" },
      instructions: "?",
      type: "choice" as const,
    },
  };
  const cases = [
    reply({
      answers: {
        kind: { choice: "other", probabilities: {}, type: "choice" },
      },
      model: "m",
    }),
    reply({ answers: {}, model: "m" }),
    reply({}, 500),
  ];
  await Promise.all(
    cases.map((response) =>
      assert.rejects(
        askJev(question, "s", { fetch: () => response, token: "t" })
      )
    )
  );
});

test("askJev stops before the request when the call is already cancelled", async () => {
  let called = false;
  const cancelled = (token?: string) =>
    askJev({ refund: { instructions: "?", type: "boolean" } }, "s", {
      fetch: () => {
        called = true;
        return reply({ answers: {}, model: "m" });
      },
      signal: AbortSignal.abort(),
      ...(token ? { token } : {}),
    });
  await assert.rejects(cancelled());
  await assert.rejects(cancelled("t"));
  assert.equal(called, false);
});

test("a follow-up stays quiet only on a clear skip", () => {
  assert.equal(resolveFollowUp({ follow_up: pick("skip") }), "skip");
  assert.equal(resolveFollowUp({ follow_up: pick("respond", 0.4) }), "respond");
  assert.equal(
    resolveFollowUp({ follow_up: pick("skip", 0.5) }),
    "respond",
    "an unsure skip answers the requester"
  );
});

test("a clear status-only follow-up is moved without re-checking", () => {
  assert.equal(
    resolveFollowUp({ follow_up: pick("respond"), status_only: yes(0.9) }),
    "status"
  );
  assert.equal(
    resolveFollowUp({ follow_up: pick("respond"), status_only: yes(0.6) }),
    "respond",
    "an unsure status move is handled as a normal follow-up"
  );
  assert.equal(
    resolveFollowUp({ follow_up: pick("skip"), status_only: yes(0.9) }),
    "skip"
  );
});

test("a follow-up that is only mentions is skipped without asking Jev", async () => {
  const outcome = await decideFollowUp(
    {
      lastReply: "Which amount?",
      replies: [
        "https://linear.app/acquisity/profiles/acquisityforeman1 **Gary** replied in Slack:\n\n<@U0950315SDC>",
        " <@U1|bot> ",
      ],
    },
    {
      fetch: () => {
        throw new Error("Jev should not be asked.");
      },
      token: "t",
    }
  );
  assert.equal(outcome, "skip");
});

test("a relayed reply reaches Jev as the speaker and their words, mentions as Foreman or teammates", () => {
  assert.equal(
    followUpText(
      "https://linear.app/acquisity/profiles/acquisityforeman1 **Aaron Fraga** replied in Slack:\n\nHey <@U06M69EP1UG>! what was agreed?"
    ),
    "Aaron Fraga: Hey @teammate! what was agreed?"
  );
  assert.equal(
    followUpText(
      "**Aaron Fraga** replied in Slack:\n\n<@U0BQ5QMHM7D> can u move this to done please"
    ),
    "Aaron Fraga: @Foreman can u move this to done please"
  );
  assert.equal(followUpText("just text"), "Someone: just text");
  assert.equal(
    followUpText(
      "**Dana** added a note in the support inbox:\n\nIs their domain verified?"
    ),
    "Dana: Is their domain verified?"
  );
});

test("a reviewed Bug carries its hotlane route; a duplicate or non-Bug carries none", () => {
  const standard = resolveTriage(triageInput(), bugAnswers());
  assert.ok(standard.outcome === "route");
  assert.deepEqual(standard.hotlane, {
    impact: "MATERIALLY_IMPAIRED",
    notes: [],
    proposedLabel: "none",
    route: "STANDARD_ENGINEERING",
  });

  const hot = resolveTriage(
    triageInput(),
    bugAnswers({ incident: pick("hotlane"), incident_impact: pick("BLOCKED") })
  );
  assert.ok(hot.outcome === "route");
  assert.equal(hot.hotlane?.route, "HOTLANE");
  assert.equal(hot.hotlane?.proposedLabel, "fast-lane");

  const userError = resolveTriage(
    triageInput(),
    bugAnswers({ classification: pick("user_error"), path: pick("User Error") })
  );
  assert.ok(userError.outcome === "route");
  assert.equal(userError.hotlane, undefined);
});

test("an unconfirmed or unsure hotlane goes to a person, never routine work", () => {
  for (const incident of [
    pick("needs_human_urgent", 0.4),
    pick("hotlane", 0.5),
  ]) {
    const decision = resolveTriage(triageInput(), bugAnswers({ incident }));
    assert.ok(decision.outcome === "route");
    assert.equal(decision.hotlane?.route, "NEEDS_HUMAN_URGENT");
    assert.equal(decision.hotlane?.impact, "UNCONFIRMED");
    assert.equal(decision.hotlane?.proposedLabel, "none");
  }
});

const candidate = (identifier: string) => ({
  identifier,
  summary: "s",
  title: "t",
});

test("an attached master makes a known issue whatever Jev thinks of the match", () => {
  const input = { candidates: [], parent: candidate("ENG-5"), report: "r" };
  const matched = resolvePriorWork(input, { parent_match: yes() });
  assert.equal(matched.outcome, "known_issue");
  assert.equal(matched.knownIssue, "ENG-5");
  assert.deepEqual(matched.notes, []);
  const doubted = resolvePriorWork(input, { parent_match: no() });
  assert.equal(doubted.outcome, "known_issue");
  assert.equal(doubted.notes.length, 1);
});

test("with no master, a bug is fresh without asking Jev", async () => {
  const decision = await decidePriorWork(
    { candidates: [], report: "r" },
    {
      fetch: () => {
        throw new Error("Jev must not be called.");
      },
      token: "t",
    }
  );
  assert.equal(decision.outcome, "fresh");
});

test("a live existing investigation is a continuation, a stale one is not", () => {
  const input = {
    candidates: [],
    existingInvestigation: "Found the webhook drop.",
    report: "r",
  };
  assert.equal(
    resolvePriorWork(input, { continuation: yes() }).outcome,
    "continuation"
  );
  assert.equal(
    resolvePriorWork(input, { continuation: no() }).outcome,
    "fresh"
  );
});

test("a same-outcome candidate is a known issue; a weak one is only related", () => {
  const input = {
    candidates: [candidate("ENG-7"), candidate("ENG-8")],
    report: "r",
  };
  const known = resolvePriorWork(input, {
    candidate_0: pick("partial_or_adjacent"),
    candidate_1: pick("same_outcome", 0.7),
  });
  assert.equal(known.outcome, "known_issue");
  assert.equal(known.knownIssue, "ENG-8");
  assert.deepEqual(known.candidates, [
    { identifier: "ENG-7", match: "partial_or_adjacent" },
    { identifier: "ENG-8", match: "same_outcome" },
  ]);

  const weak = resolvePriorWork(input, {
    candidate_0: pick("not_relevant"),
    candidate_1: pick("same_outcome", 0.4),
  });
  assert.equal(weak.outcome, "fresh");
  assert.equal(weak.candidates[1]?.match, "partial_or_adjacent");
});

const DRAFT =
  "I found the failed run in Inngest. The fix is deployed.\nCan you retry?";

test("a draft splits into one claim per sentence or line", () => {
  assert.deepEqual(splitClaims(DRAFT), [
    "I found the failed run in Inngest.",
    "The fix is deployed.",
    "Can you retry?",
  ]);
});

test("a grounding flag marks the claim unconfirmed and still returns a reply to send", () => {
  const claims = splitClaims(DRAFT);
  const result = resolveGrounding(DRAFT, claims, {
    done_0: no(),
    done_1: yes(),
    done_2: no(),
    shown_0: yes(),
    shown_1: yes(0.6),
    shown_2: yes(),
  });
  assert.deepEqual(result.flagged, [
    { claim: "The fix is deployed.", reason: "done_unconfirmed" },
  ]);
  assert.equal(
    result.reply,
    "I found the failed run in Inngest. The fix is deployed (unconfirmed).\nCan you retry?"
  );

  const notShown = resolveGrounding(DRAFT, claims, {
    done_0: no(),
    done_1: no(),
    done_2: no(),
    shown_0: no(),
    shown_1: yes(),
    shown_2: yes(),
  });
  assert.equal(notShown.flagged[0]?.reason, "not_shown");
  assert.ok(
    notShown.reply.startsWith(
      "I found the failed run in Inngest (unconfirmed)."
    )
  );
});

test("a flagged reply comes back from Jev adjusted and ready to send", async () => {
  const result = await checkGrounding(
    { draft: "The fix is deployed.", evidence: "No deploy was checked." },
    {
      fetch: () =>
        reply({
          answers: {
            done_0: { probability: 0.95, type: "boolean" },
            shown_0: { probability: 0.1, type: "boolean" },
          },
          model: "typesafe-ai/jev",
        }),
      token: "t",
    }
  );
  assert.equal(result.checked, true);
  assert.equal(result.reply, "The fix is deployed (unconfirmed).");
});

test("a Jev failure or timeout sends the draft unchanged", async () => {
  const results = await Promise.all(
    [
      () => reply({}, 503),
      () => Promise.reject(new Error("The operation timed out.")),
    ].map((fetch) =>
      checkGrounding({ draft: DRAFT, evidence: "e" }, { fetch, token: "t" })
    )
  );
  for (const result of results) {
    assert.deepEqual(result, {
      checked: false,
      flagged: [],
      reason: "jev_failed",
      reply: DRAFT,
    });
  }
});

test("a cancelled turn is not mistaken for a Jev failure", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    checkGrounding(
      { draft: DRAFT, evidence: "e" },
      { signal: controller.signal, token: "t" }
    )
  );
});

test("grounding adjusts only the flagged occurrence and preserves literal reply text", () => {
  for (const draft of [
    "  Fixed. Fixed.\n",
    "  Not yet Fixed. Fixed.\n",
    "  Evidence mentions $& and $`. Fixed.\n",
  ]) {
    const claims = splitClaims(draft);
    const result = resolveGrounding(draft, claims, {
      done_0: no(),
      done_1: yes(),
      shown_0: yes(),
      shown_1: no(),
    });
    assert.equal(result.reply, `${draft.slice(0, -7)}Fixed (unconfirmed).\n`);
    assert.deepEqual(result.flagged, [
      { claim: "Fixed.", reason: "not_shown" },
    ]);
  }
  const draft = "Sent $& and $` and $' and $1.";
  assert.equal(
    resolveGrounding(draft, splitClaims(draft), { shown_0: no() }).reply,
    "Sent $& and $` and $' and $1 (unconfirmed)."
  );
});

test("a reply beyond the claim limit is sent unchanged without a partial success", async () => {
  const draft = `${"Confirmed.\n".repeat(40)}Everything is deployed.`;
  let asked = false;
  const result = await checkGrounding(
    { draft, evidence: "No deployment was checked." },
    {
      fetch: () => {
        asked = true;
        throw new Error("An oversized draft must not be partially checked.");
      },
      token: "t",
    }
  );
  assert.equal(asked, false);
  assert.deepEqual(result, {
    checked: false,
    flagged: [],
    reason: "oversized",
    reply: draft,
  });
});

test("a reply at the claim limit is still checked in full", async () => {
  const draft = `${"Confirmed.\n".repeat(39)}Everything is deployed.`;
  let asked = false;
  const result = await checkGrounding(
    { draft, evidence: "No deployment was checked." },
    {
      fetch: (_url, init) => {
        asked = true;
        const { questions } = JSON.parse(init.body as string);
        assert.equal(Object.keys(questions).length, 80);
        return reply({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              key === "shown_39" ? no() : yes(),
            ])
          ),
          model: "typesafe-ai/jev",
        });
      },
      token: "t",
    }
  );
  assert.equal(asked, true);
  assert.equal(result.checked, true);
  assert.equal(
    result.reply,
    `${"Confirmed.\n".repeat(39)}Everything is deployed (unconfirmed).`
  );
});
