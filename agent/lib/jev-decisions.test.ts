import assert from "node:assert/strict";
import { test } from "node:test";
import { askJev, type JevAnswer } from "./jev.js";
import {
  type BillingInput,
  billingQuestions,
  decideFollowUp,
  resolveBilling,
  resolveFollowUp,
  resolveTriage,
  type TriageInput,
  triageQuestions,
} from "./jev-decisions.js";

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

test("a follow-up stays quiet only on a clear skip or note", () => {
  assert.equal(resolveFollowUp({ follow_up: pick("skip") }), "skip");
  assert.equal(resolveFollowUp({ follow_up: pick("note") }), "note");
  assert.equal(resolveFollowUp({ follow_up: pick("respond", 0.4) }), "respond");
  for (const quiet of ["skip", "note"]) {
    assert.equal(
      resolveFollowUp({ follow_up: pick(quiet, 0.5) }),
      "respond",
      `an unsure ${quiet} answers the requester`
    );
  }
});

test("a follow-up that is only mentions is skipped without asking Jev", async () => {
  const outcome = await decideFollowUp(
    { lastReply: "Which amount?", replies: ["<@U0950315SDC>", " <@U1|bot> "] },
    {
      fetch: () => {
        throw new Error("Jev should not be asked.");
      },
      token: "t",
    }
  );
  assert.equal(outcome, "skip");
});
