import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { type GateDeps, gate } from "./widget-egress.js";
import { extractWidgetFindings } from "./widget-extract.js";
import { finishWidgetRun, widgetRunResponse } from "./widget-investigation.js";
import { handoffEligible } from "./widget-next-action.js";
import type { WidgetRun } from "./widget-run-store.js";

/**
 * The outcome boundary of one finished investigation, with only the models
 * faked: the real extraction normalizer, the real eligibility request, the real
 * egress gate, and the rule the Acquisity app applies to what comes back.
 */
const owned = {
  domains: new Set<string>(),
  emails: new Set<string>(),
  slugs: new Set<string>(),
  uuids: new Set<string>(),
};
const gateDeps: GateDeps = {
  compose: ({ findings }) =>
    Promise.resolve(
      `${findings.facts.map((fact) => fact.claim).join(" ")} ${findings.recommendation}`
    ),
  judge: () => Promise.resolve({ decision: "allow", reason: "in scope" }),
  resolve: () => Promise.resolve(owned),
};

/** apps/web/trpc/routers/support.ts: any of these takes the thread from Foreman. */
const acquisityHandsOff = (result: ReturnType<typeof widgetRunResponse>) =>
  "decision" in result &&
  (result.decision === "block" ||
    (result.findings as { needsHuman?: boolean } | undefined)?.needsHuman ===
      true ||
    !result.message);

interface Case {
  eligible: number | "down";
  extracted: {
    facts: { claim: string }[];
    needsHuman: boolean;
    recommendation: string;
    report: string;
  };
  judge?: GateDeps["judge"];
  question: string;
}

async function finish(t: TestContext, input: Case, flag = "jev") {
  const previous = process.env.WIDGET_NEXT_ACTION;
  process.env.WIDGET_NEXT_ACTION = flag;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.WIDGET_NEXT_ACTION;
    } else {
      process.env.WIDGET_NEXT_ACTION = previous;
    }
  });
  const run: WidgetRun = {
    completed_at: null,
    created_at: new Date(),
    decision: null,
    findings: null,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outcome: null,
    question: input.question,
    scope,
    session_id: "s",
    stream_index: 0,
  };
  const asked: string[] = [];
  const finished = await finishWidgetRun(
    run,
    "s",
    { findings: null, status: "completed", text: "investigator prose" },
    {
      claimFinish: () => Promise.resolve(true),
      complete: (_id, outcome, stored) => {
        run.outcome = outcome;
        run.findings = stored;
        return Promise.resolve(run);
      },
      extract: (extract) =>
        extractWidgetFindings(extract, {
          generate: () => Promise.resolve(input.extracted),
        }),
      gate: (gateScope, question, findings, _deps, conversation) =>
        gate(
          gateScope,
          question,
          findings,
          { ...gateDeps, judge: input.judge ?? gateDeps.judge },
          conversation
        ),
      handoffEligible: (check) =>
        handoffEligible(check, {
          apiKey: "k",
          fetch: (_url, init) => {
            asked.push(init.body);
            return input.eligible === "down"
              ? Promise.reject(new Error("down"))
              : Promise.resolve({
                  json: () =>
                    Promise.resolve({
                      answers: { handoff_eligible: { noul: input.eligible } },
                    }),
                  ok: true,
                  status: 200,
                });
          },
        }),
      history: () => Promise.resolve([]),
    }
  );
  assert.ok(finished);
  return { asked, response: widgetRunResponse(finished) };
}

const inboxes: Case = {
  eligible: 0.1,
  extracted: {
    facts: [
      { claim: "12 inboxes are ready and none show an error." },
      {
        claim:
          "Order counts from January and June differ from the current inbox count, which could not be explained.",
      },
    ],
    needsHuman: true,
    recommendation:
      "No inbox needs attention. The older order counts could not be matched.",
    report:
      "Inboxes look healthy. Old order counts differ; billing may want a look.",
  },
  question: "Are any of my inboxes currently broken?",
};
const plan: Case = {
  eligible: 0.2,
  extracted: {
    facts: [
      {
        claim:
          "The workspace is on the Pro plan and the subscription is active.",
      },
      {
        claim:
          "Two records disagree on the credit balance, so it is unconfirmed.",
      },
    ],
    needsHuman: true,
    recommendation:
      "Your plan is Pro and active. The exact balance could not be confirmed.",
    report: "Plan is Pro, active. Balance records conflict.",
  },
  question: "What plan am I on, is it active, and what is my balance?",
};

test("a healthy-inbox answer with an incidental old billing difference reaches the customer, caveat included", async (t) => {
  const { response } = await finish(t, inboxes);
  assert.equal(acquisityHandsOff(response), false);
  assert.ok("message" in response);
  assert.equal((response.message ?? "").includes("12 inboxes are ready"), true);
  assert.equal(
    (response.message ?? "").includes("could not be explained"),
    true
  );
});

test("a plan and balance answer with conflicting records reaches the customer with the conflict stated", async (t) => {
  const { response } = await finish(t, plan);
  assert.equal(acquisityHandsOff(response), false);
  assert.ok("message" in response);
  assert.equal((response.message ?? "").includes("Pro plan"), true);
  assert.equal((response.message ?? "").includes("unconfirmed"), true);
});

test("the eligibility check reads the customer's words and the findings, and nothing else", async (t) => {
  const { asked } = await finish(t, inboxes);
  assert.equal(asked.length, 1);
  const { state } = JSON.parse(asked[0]) as { state: string };
  assert.equal(state.includes("Are any of my inboxes currently broken"), true);
  assert.equal(state.includes("12 inboxes are ready"), true);
  assert.equal(state.includes("investigator prose"), false);
});

test("an explicit request for a person still hands off with its findings", async (t) => {
  const { response } = await finish(t, {
    ...inboxes,
    eligible: 0.95,
    question: "I want to talk to a person about my inboxes.",
  });
  assert.equal(acquisityHandsOff(response), true);
  assert.ok("findings" in response);
  assert.equal((response.findings as { facts: unknown[] }).facts.length, 2);
});

test("a complex billing dispute hands off and the unconfirmed attribution survives in the teammate findings", async (t) => {
  const claim =
    "An order for 18 inboxes exists and 6 inboxes were created. Which charge paid for that order could not be confirmed.";
  const { response } = await finish(t, {
    eligible: 0.9,
    extracted: {
      facts: [{ claim }],
      needsHuman: true,
      recommendation: "Billing needs to reconcile the order with its payment.",
      report:
        "18 ordered, 6 created; payment for the order is unconfirmed. Billing to reconcile.",
    },
    question: "I paid for 18 inboxes and only got 6.",
  });
  assert.equal(acquisityHandsOff(response), true);
  assert.ok("findings" in response);
  const stored = response.findings as {
    facts: { claim: string }[];
    report: string;
  };
  assert.equal(stored.facts[0].claim, claim);
  assert.equal(stored.report.includes("unconfirmed"), true);
});

test("clearing the flag bypasses no block: the reviewer still stops an answer that is not the customer's to see", async (t) => {
  const { response } = await finish(t, {
    ...inboxes,
    judge: () => Promise.resolve({ decision: "block", reason: "foreign data" }),
  });
  assert.equal(acquisityHandsOff(response), true);
  assert.ok("decision" in response);
  assert.equal(response.decision, "block");
});

test("when eligibility cannot be checked the findings stand: a legitimate handoff is never silently cleared", async (t) => {
  const { response } = await finish(t, { ...inboxes, eligible: "down" });
  assert.equal(acquisityHandsOff(response), true);
});

test("with the pilot flag off nothing is checked and nothing changes", async (t) => {
  const { asked, response } = await finish(t, inboxes, "");
  assert.equal(asked.length, 0);
  assert.equal(acquisityHandsOff(response), true);
});

test("a necessary clarification with no facts is a reply, not a handoff", async (t) => {
  const { asked, response } = await finish(t, {
    eligible: 0,
    extracted: {
      facts: [],
      needsHuman: false,
      recommendation: "Which campaign do you mean: A or B?",
      report: "Asked which campaign.",
    },
    question: "Why did my campaign stop?",
  });
  assert.equal(asked.length, 0);
  assert.equal(acquisityHandsOff(response), false);
});

// Run d5822f74: Jev chose clarify in 359ms, then structuring and composing a
// report around one question took 25 of the 34 finishing seconds.
test("a post-tool clarify question is delivered without structuring or composing a report, and still passes the scan and the reviewer", async (t) => {
  process.env.WIDGET_NEXT_ACTION = "jev";
  t.after(() => {
    delete process.env.WIDGET_NEXT_ACTION;
  });
  const run: WidgetRun = {
    completed_at: null,
    created_at: new Date(),
    decision: null,
    findings: null,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outcome: null,
    question: "Why did my campaign stop?",
    scope,
    session_id: "s",
    stream_index: 0,
  };
  const reviewed: string[] = [];
  const finishWith = (text: string, judge: GateDeps["judge"]) =>
    finishWidgetRun(
      run,
      "s",
      { findings: null, status: "completed", text },
      {
        claimFinish: () => Promise.resolve(true),
        complete: (_id, outcome, stored) => {
          run.outcome = outcome;
          run.findings = stored;
          return Promise.resolve(run);
        },
        extract: () => assert.fail("a question is not structured by a model"),
        gate: (gateScope, question, findings, deps, conversation) =>
          gate(
            gateScope,
            question,
            findings,
            {
              compose: deps?.compose ?? gateDeps.compose,
              judge,
              resolve: gateDeps.resolve,
            },
            conversation
          ),
        history: () => Promise.resolve([]),
      }
    );
  const asked = "Which campaign do you mean, Spring Promo or Autumn Promo?";
  const finished = await finishWith(
    `QUESTION FOR CUSTOMER: ${asked}`,
    (input) => {
      reviewed.push(input.items.map((item) => item.text).join("|"));
      return Promise.resolve({ decision: "allow", reason: "in scope" });
    }
  );
  assert.ok(finished);
  const response = widgetRunResponse(finished);
  assert.equal(acquisityHandsOff(response), false);
  assert.ok("message" in response);
  assert.equal(response.message, asked);
  assert.equal(reviewed[0].includes(asked), true);

  // 8788da8 re-emitted the text as written: the reviewer deleted the first
  // sentence and the customer still got both.
  const partly = await finishWith(
    "QUESTION FOR CUSTOMER: Buy another domain. Which campaign do you mean?",
    (input) =>
      Promise.resolve({
        decision: "rewrite",
        reason: "unsupported step",
        remove: input.items
          .filter((item) => item.text.includes("Buy another domain"))
          .map((item) => item.n),
      })
  );
  assert.ok(partly);
  const trimmed = widgetRunResponse(partly);
  assert.ok("message" in trimmed);
  assert.equal(trimmed.message, "Which campaign do you mean?");

  // If the reviewer deletes the question itself, the leftover statement is not sent.
  const noQuestion = await finishWith(
    "QUESTION FOR CUSTOMER: Buy another domain. Which campaign do you mean?",
    (input) =>
      Promise.resolve({
        decision: "rewrite",
        reason: "x",
        remove: input.items
          .filter((item) => item.text.includes("Which campaign"))
          .map((item) => item.n),
      })
  );
  assert.ok(noQuestion);
  const dropped = widgetRunResponse(noQuestion);
  assert.ok("message" in dropped);
  assert.equal(dropped.message, null);

  // The reviewer can still stop it, and then nothing reaches the customer.
  const blocked = await finishWith(`QUESTION FOR CUSTOMER: ${asked}`, () =>
    Promise.resolve({ decision: "block", reason: "foreign data" })
  );
  assert.ok(blocked);
  const stopped = widgetRunResponse(blocked);
  assert.ok("message" in stopped);
  assert.equal(stopped.message, null);
});

test("a write-up that is more than the one question takes the ordinary path", async (t) => {
  const { response } = await finish(t, {
    eligible: 0,
    extracted: {
      facts: [{ claim: "Two campaigns are paused." }],
      needsHuman: false,
      recommendation: "Which campaign do you mean?",
      report: "Asked which campaign.",
    },
    question: "Why did my campaign stop?",
  });
  assert.ok("message" in response);
  assert.equal(
    (response.message ?? "").includes("Two campaigns are paused."),
    true
  );
});
