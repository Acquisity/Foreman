import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { GateResult } from "./widget-egress.js";
import type { WidgetFindings } from "./widget-findings.js";
import {
  finishWidgetRun,
  INVESTIGATE_REDIRECT,
  receiveWidgetMessage,
  WIDGET_DEADLINE_MS,
  type WidgetDependencies,
  waitForWidgetInvestigation,
  widgetRunResponse,
} from "./widget-investigation.js";
import type { KbCustomer } from "./widget-kb.js";
import { routeWidgetMessage, type WidgetRoute } from "./widget-router.js";
import type { WidgetRun } from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";

const SERVICE_SECRET = "s".repeat(40);
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROBLEM =
  "I was charged twice for my plan this month and want the second charge back";
const findings: WidgetFindings = {
  confidence: "high",
  facts: [],
  needsHuman: false,
  recommendation: "Reconnect the inbox.",
  report: "The sending inbox is disconnected.",
};
const allowed: GateResult = {
  decision: "allow",
  findings,
  message: "Your inbox disconnected.",
  reason: "in scope",
};

function setEnv(t: TestContext, key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

const enable = (t: TestContext, escalation = true) => {
  setEnv(t, "SUPPORT_CHAT_ENABLED", "true");
  setEnv(t, "FOREMAN_DIAGNOSTICS_SECRET", SERVICE_SECRET);
  setEnv(t, "WIDGET_ESCALATE_TO_FIXY", escalation ? "on" : undefined);
};

/** A fresh run whose store is this object, a filer that records, and a router answering `route`. */
function harness(route: Omit<WidgetRoute, "source"> = { asksForHuman: 0 }) {
  const run: WidgetRun = {
    completed_at: null,
    created_at: new Date(),
    decision: null,
    findings: null,
    id: runId,
    outcome: null,
    question: PROBLEM,
    scope,
    session_id: null,
    stream_index: 0,
  };
  const filed: unknown[] = [];
  const gated: unknown[] = [];
  const deps: WidgetDependencies = {
    // The guide lane starts drafting while the router scores; an escalation drops it unread.
    answerChat: () => new Promise(() => undefined),
    answerKb: () => assert.fail("must not answer from the help center"),
    attach: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    claim: () => Promise.resolve({ fresh: true, run }),
    claimFinish: () => Promise.resolve(true),
    complete: (_id, outcome, stored) => {
      run.outcome = outcome;
      run.findings = stored;
      run.completed_at = new Date();
      return Promise.resolve(run);
    },
    expire: () => assert.fail("a live run must not be expired"),
    expireAll: () => Promise.resolve([]),
    extract: () => Promise.resolve(findings),
    fileTicket: (_scope, input) => {
      filed.push(input);
      return Promise.resolve({
        existing: false,
        identifier: "ENG-1",
        refund: false,
        url: "https://linear.app/acquisity/issue/ENG-1/x",
      });
    },
    gate: (_scope, _question, raw) => {
      gated.push(raw);
      return Promise.resolve(allowed);
    },
    handoffEligible: () => Promise.resolve(true),
    history: () => Promise.resolve([]),
    latestScope: () => Promise.resolve(null),
    read: () => Promise.resolve(run),
    readTicket: () => Promise.resolve(null),
    route: () => Promise.resolve({ ...route, source: "jev" as const }),
    verifyAccess: () =>
      Promise.resolve({
        domains: new Set<string>(),
        emails: new Set<string>(),
        slugs: new Set<string>(),
        uuids: new Set<string>(),
      }),
  };
  return { deps, filed, gated, run };
}

const send = (
  deps: WidgetDependencies,
  body: Record<string, unknown>,
  verified: WidgetContext = scope,
  from: () => never = () => assert.fail("must not start a session")
) =>
  receiveWidgetMessage(
    new Request("https://foreman.example/internal/widget/message", {
      body: JSON.stringify({
        conversation_id: scope.conversationId,
        message_id: crypto.randomUUID(),
        organization_id: scope.organizationId,
        question: PROBLEM,
        ...body,
      }),
      headers: {
        authorization: "Bearer signed.user.identity",
        "content-type": "application/json",
        "x-acquisity-service-secret": SERVICE_SECRET,
      },
      method: "POST",
    }),
    { from, waitUntil: () => undefined },
    200,
    () => Promise.resolve(verified),
    deps
  );

const escalateOf = (run: WidgetRun) =>
  (run.findings as WidgetFindings).escalate;

test("an ask for a person, a cancel or a refund hands the chat to Fixy with no reply and no ticket, the most specific need first", async (t) => {
  enable(t);
  for (const [route, question, reason] of [
    [{ asksForHuman: 0.95, noNeed: true }, "human agent", "asked_for_human"],
    [{ asksForHuman: 0.95 }, PROBLEM, "asked_for_human"],
    [{ asksForHuman: 0.95, refund: true }, PROBLEM, "refund"],
    [{ asksForHuman: 0.95, cancel: true, refund: true }, PROBLEM, "cancel"],
    [{ asksForHuman: 0, refund: true }, "Yes, last Friday", "refund"],
  ] as const) {
    const { deps, filed, run } = harness(route);
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await send(deps, { question });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.decision, "allow");
    assert.equal(body.message, null);
    assert.equal(run.outcome?.reason, `escalated_to_fixy ${reason}`);
    assert.deepEqual(escalateOf(run), { reason });
    assert.deepEqual((body.findings as WidgetFindings).escalate, { reason });
    assert.equal(filed.length, 0);
  }
});

test("a toggled ask for a person or a cancel escalates, while an owner's toggled refund still investigates", async (t) => {
  enable(t);
  for (const [route, reason] of [
    [{ asksForHuman: 0.95 }, "asked_for_human"],
    [{ asksForHuman: 0, cancel: true }, "cancel"],
  ] as const) {
    const { deps, filed, run } = harness(route);
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await send(deps, { mode: "investigate" });
    assert.equal(run.outcome?.reason, `escalated_to_fixy ${reason}`);
    assert.equal(filed.length, 0);
  }
  // The refund goes on to the investigation; this one fails to start, so it
  // escalates as blocked instead of leaving the customer at a dead end.
  for (const asksForHuman of [0, 0.95]) {
    const { deps, filed, run } = harness({ asksForHuman, refund: true });
    let started = false;
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await send(deps, { mode: "investigate" }, scope, () => {
      started = true;
      throw new Error("session unavailable");
    });
    assert.ok(started, "the refund reached the investigation");
    assert.equal(response.status, 200);
    assert.equal(run.outcome?.reason, "escalated_to_fixy blocked");
    assert.equal(
      filed.length,
      0,
      "the investigator files it, not the old filer"
    );
  }
  // An outage of the access check, unlike a denial, hands the chat on too.
  const { deps, run } = harness({ asksForHuman: 0, refund: true });
  deps.verifyAccess = () => Promise.reject(new Error("unavailable"));
  const response = await send(deps, { mode: "investigate" });
  assert.equal(response.status, 200);
  assert.equal(run.outcome?.reason, "escalated_to_fixy blocked");
});

test("a member who needs a look escalates as cant_check; a teammate's run never escalates", async (t) => {
  enable(t);
  for (const role of ["member", "client"] as const) {
    const { deps, filed, run } = harness({ asksForHuman: 0, bug: true });
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await send(deps, {}, { ...scope, role });
    assert.equal(run.outcome?.reason, "escalated_to_fixy cant_check");
    assert.equal(filed.length, 0);
  }
  const { deps, run } = harness({ asksForHuman: 0.95, cancel: true });
  const response = await send(
    deps,
    { mode: "investigate", staff: true },
    { ...scope, source: "inbox" },
    () => {
      throw new Error("session unavailable");
    }
  );
  assert.equal(response.status, 503);
  assert.equal(run.outcome?.reason, "session_unavailable");
  assert.equal(run.findings, null);
});

test("findings that need a person escalate as cant_check, keep the ticket the investigator filed, and reach the app", async (t) => {
  enable(t);
  const { deps, filed, gated, run } = harness();
  deps.extract = () => Promise.resolve({ ...findings, needsHuman: true });
  await finishWidgetRun(
    run,
    "widget-session-needs",
    {
      findings: null,
      status: "completed",
      text: "Needs a person.",
      ticket: {
        id: "ENG-7",
        url: "https://linear.app/acquisity/issue/ENG-7/bug",
      },
    },
    deps
  );
  assert.equal(gated.length, 0, "nothing is composed");
  assert.equal(filed.length, 0);
  const body = widgetRunResponse(run) as Record<string, unknown>;
  assert.equal(body.message, null);
  const returned = body.findings as WidgetFindings;
  assert.deepEqual(returned.escalate, { reason: "cant_check" });
  assert.deepEqual(returned.ticket, {
    id: "ENG-7",
    url: "https://linear.app/acquisity/issue/ENG-7/bug",
  });
  assert.equal(returned.report, findings.report);
});

test("a write-up with no structured findings escalates as blocked and keeps the ticket the turn filed", async (t) => {
  enable(t);
  const { deps, run } = harness();
  deps.extract = () => Promise.resolve(null);
  await finishWidgetRun(
    run,
    "widget-session-prose",
    {
      findings: null,
      status: "completed",
      text: "Prose only.",
      ticket: {
        id: "ENG-7",
        url: "https://linear.app/acquisity/issue/ENG-7/bug",
      },
    },
    deps
  );
  assert.equal(run.outcome?.reason, "escalated_to_fixy blocked");
  assert.equal((run.findings as WidgetFindings).ticket?.id, "ENG-7");
});

test("a blocked finish and an overdue investigation escalate as blocked; a retryable block stays a resend", async (t) => {
  enable(t);
  for (const [reason, escalated] of [
    ["model_gate:unsafe", true],
    ["gate_unavailable", false],
  ] as const) {
    const { deps, filed, run } = harness();
    deps.gate = () =>
      Promise.resolve({ decision: "block", findings, message: null, reason });
    deps.readTicket = () =>
      Promise.resolve({
        existing: false,
        identifier: "ENG-9",
        refund: true,
        url: "https://linear.app/acquisity/issue/ENG-9/refund",
      });
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await finishWidgetRun(
      run,
      "widget-session-block",
      { findings: null, status: "completed", text: "Blocked." },
      deps
    );
    assert.equal(filed.length, 0);
    assert.equal(
      run.outcome?.reason,
      escalated ? "escalated_to_fixy blocked" : reason
    );
    assert.equal(escalateOf(run)?.reason, escalated ? "blocked" : undefined);
    if (escalated) {
      assert.equal((run.findings as WidgetFindings).ticket?.id, "ENG-9");
    }
  }
  // An overdue investigation would likely run out of time again on a resend,
  // so a poll that finds it overdue hands the chat on, as it filed before.
  const { deps, run } = harness();
  run.session_id = "widget-session-old";
  run.created_at = new Date(Date.now() - WIDGET_DEADLINE_MS - 1000);
  const empty = {
    getEventStream: () =>
      Promise.resolve(new ReadableStream({ start: (c) => c.close() })),
    id: "widget-session-old",
  };
  await receiveWidgetMessage(
    new Request("https://foreman.example/internal/widget/message", {
      body: JSON.stringify({
        action: "result",
        conversation_id: scope.conversationId,
        organization_id: scope.organizationId,
        run_id: runId,
      }),
      headers: {
        authorization: "Bearer signed.user.identity",
        "content-type": "application/json",
        "x-acquisity-service-secret": SERVICE_SECRET,
      },
      method: "POST",
    }),
    {
      attachSession: () => empty as never,
      from: () => assert.fail("must not start a session"),
      waitUntil: () => undefined,
    },
    5,
    () => Promise.resolve(scope),
    deps
  );
  assert.equal(run.outcome?.reason, "escalated_to_fixy blocked");
});

test("with escalation off, the cancel score leaves the old invitation alone and nothing escalates", async (t) => {
  enable(t, false);
  const route = await routeWidgetMessage("get me a person to downgrade", {
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              asks_for_human: { noul: 0.95 },
              asks_to_cancel: { noul: 0.95 },
              states_need: { noul: 0.1 },
            },
          }),
        ok: true,
        status: 200,
      }),
  });
  assert.equal(route.cancel, undefined);
  assert.equal(route.noNeed, true);
  const { deps, filed, run } = harness({ asksForHuman: 0.95, refund: true });
  deps.answerChat = () =>
    Promise.resolve({ citations: [], message: "Here is how refunds work." });
  await send(deps, {});
  assert.equal(escalateOf(run), undefined);
  assert.equal(filed.length, 1, "the old path still files the ticket");
});

test("an escalation the investigator's own output claims is dropped", async () => {
  const events = [
    {
      data: {
        result: {
          ...findings,
          escalate: { reason: "refund" },
        },
      },
      type: "result.completed",
    },
    { data: {}, type: "turn.completed" },
  ];
  const outcome = await waitForWidgetInvestigation(
    {
      getEventStream: () =>
        Promise.resolve(
          new ReadableStream({
            start(controller) {
              for (const event of events) {
                controller.enqueue(event);
              }
              controller.close();
            },
          })
        ),
      id: "widget-session-claims",
    } as never,
    0,
    1000
  );
  assert.equal(outcome.status, "completed");
  if (outcome.status === "completed") {
    assert.deepEqual(outcome.findings, findings);
  }
});

test("an owner asking for a ticket again after the magnifying glass escalates instead of hearing the redirect twice; off, the redirect repeats as before", async (t) => {
  const earlier = [
    { role: "customer", text: "Can you open a ticket for this?" },
    { role: "assistant", text: INVESTIGATE_REDIRECT },
  ];
  // A mention that is not the fixed redirect leaves the first ticket ask on the redirect.
  const mention = [
    { role: "customer", text: "Do I need the magnifying glass for settings?" },
    {
      role: "assistant",
      text: "You don't need the magnifying glass to check those settings.",
    },
  ];
  for (const [on, history, reason] of [
    [true, undefined, "investigate_redirect"],
    [true, mention, "investigate_redirect"],
    [true, earlier, "escalated_to_fixy asked_for_human"],
    [false, earlier, "investigate_redirect"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each case restores the flag before the next.
    await t.test(`${on ? "on" : "off"}, ${reason}`, async (st) => {
      enable(st, on);
      const { deps, filed, run } = harness({ asksForHuman: 0, ticket: true });
      const body = (await (
        await send(deps, { history, question: "Please raise a ticket" })
      ).json()) as Record<string, unknown>;
      assert.equal(run.outcome?.reason, reason);
      assert.equal(
        body.message,
        reason === "investigate_redirect" ? INVESTIGATE_REDIRECT : null
      );
      assert.equal(filed.length, 0);
    });
  }
});

test("on, the front-door writer is told asking here reaches a person and gets no office hours; off, it gets the hours and no such note", async (t) => {
  const officeHours = {
    customerTimeZone: "America/New_York",
    enabled: true,
    hoursText: ["Monday–Friday: 9:00 AM–5:00 PM"],
    nextOpenAt: null,
    nextOpenText: null,
    open: false,
    replyTimeMinutes: 20,
    replyTimeText: "20 minutes",
    showReplyTime: true,
    timeZone: "America/New_York",
    timeZoneName: "Eastern Time",
    upcomingClosures: [],
  };
  for (const on of [true, false]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case restores the flag before the next.
    await t.test(on ? "on" : "off", async (st) => {
      enable(st, on);
      const { deps } = harness({ asksForHuman: 0 });
      const seen: (KbCustomer | undefined)[] = [];
      deps.answerChat = (_ask, _log, writer) => {
        seen.push(writer);
        return Promise.resolve({ citations: [], message: "Here is how." });
      };
      await send(
        deps,
        { question: "When is support open?" },
        { ...scope, officeHours }
      );
      const customer = seen.at(-1);
      assert.equal(customer?.escalates, on ? true : undefined);
      assert.equal(Boolean(customer?.officeSchedule), !on);
      assert.equal(process.env.WIDGET_ESCALATE_TO_FIXY, on ? "on" : undefined);
    });
  }
});

test("an owner's toggled refund marks the run for the finish, only with escalation on", async (t) => {
  for (const [on, route, marks] of [
    [true, { asksForHuman: 0, refund: true }, 1],
    [true, { asksForHuman: 0 }, 0],
    [false, { asksForHuman: 0, refund: true }, 0],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await t.test(
      `${on ? "on" : "off"}, refund ${"refund" in route}`,
      async (st) => {
        enable(st, on);
        const { deps } = harness(route);
        const marked: string[] = [];
        deps.markRefund = (id) => {
          marked.push(id);
          return Promise.resolve();
        };
        await send(deps, { mode: "investigate" }, scope, () => {
          throw new Error("session unavailable");
        });
        assert.deepEqual(marked, marks ? [runId] : []);
      }
    );
  }
});

test("a marked refund whose investigation filed no refund ticket escalates as refund with what Foreman read; a filed refund ticket replies as before", async (t) => {
  enable(t);
  const read: WidgetFindings = {
    ...findings,
    facts: [
      {
        claim:
          "Two $252.00 charges for domains and inboxes in October; one is refunded.",
        entityIds: [],
        evidence: { ref: "", tool: "billing summary" },
      },
    ],
    recommendation: "Ask which charge they want back, then pass it to billing.",
  };
  const asked = {
    findings: null,
    status: "completed" as const,
    text: "Which charge do you want back?",
  };
  const { deps, gated, run } = harness();
  run.findings = { refundAsked: true };
  deps.extract = () => Promise.resolve(read);
  await finishWidgetRun(run, "widget-session-refund", asked, deps);
  assert.equal(gated.length, 0, "nothing is composed");
  assert.equal(run.outcome?.message, null);
  assert.equal(run.outcome?.reason, "escalated_to_fixy refund");
  const returned = run.findings as WidgetFindings;
  assert.deepEqual(returned.escalate, { reason: "refund" });
  assert.deepEqual(returned.facts, read.facts);

  const filed = harness();
  filed.run.findings = { refundAsked: true };
  filed.deps.extract = () => Promise.resolve(read);
  await finishWidgetRun(
    filed.run,
    "widget-session-refund-filed",
    {
      ...asked,
      ticket: {
        id: "ENG-9",
        refund: true,
        url: "https://linear.app/acquisity/issue/ENG-9/refund",
      },
    },
    filed.deps
  );
  assert.equal(filed.gated.length, 1, "the reply is composed as before");
  assert.equal(escalateOf(filed.run), undefined);

  const unmarked = harness();
  unmarked.deps.extract = () => Promise.resolve(read);
  await finishWidgetRun(
    unmarked.run,
    "widget-session-plain",
    asked,
    unmarked.deps
  );
  assert.equal(escalateOf(unmarked.run), undefined);
});

test("a marked refund counts the run's saved refund receipt, and a write-up the extractor cannot structure still escalates as refund", async (t) => {
  enable(t);
  const prose = {
    findings: null,
    status: "completed" as const,
    text: "Two $252 charges in October, one refunded. Which charge do they want back?",
  };
  const saved = harness();
  saved.run.findings = { refundAsked: true };
  saved.deps.readTicket = () =>
    Promise.resolve({
      existing: false,
      identifier: "ENG-9",
      refund: true,
      url: "https://linear.app/acquisity/issue/ENG-9/refund",
    });
  await finishWidgetRun(saved.run, "widget-session-receipt", prose, saved.deps);
  assert.equal(escalateOf(saved.run), undefined);
  assert.equal(saved.gated.length, 1, "the reply is composed as before");

  const unstructured = harness();
  unstructured.run.findings = { refundAsked: true };
  unstructured.deps.extract = () => Promise.resolve(null);
  await finishWidgetRun(
    unstructured.run,
    "widget-session-prose-refund",
    prose,
    unstructured.deps
  );
  assert.equal(unstructured.run.outcome?.reason, "escalated_to_fixy refund");
  assert.equal(
    (unstructured.run.findings as WidgetFindings).recommendation,
    prose.text
  );
});

test("a toggled refund in a conversation that already has a refund ticket is not marked", async (t) => {
  enable(t);
  const { deps } = harness({ asksForHuman: 0, refund: true });
  const marked: string[] = [];
  deps.markRefund = (id) => {
    marked.push(id);
    return Promise.resolve();
  };
  deps.ticketNote = () =>
    Promise.resolve({
      forInvestigator: "The refund ticket is with billing.",
      forWriters: "The refund ticket is with billing.",
      refund: true,
    });
  await send(deps, { mode: "investigate" }, scope, () => {
    throw new Error("session unavailable");
  });
  assert.deepEqual(marked, []);
});

test("a marked refund that blocks still reaches Fixy as a refund, and a question-only turn carries the write-up", async (t) => {
  enable(t);
  const failed = harness();
  failed.run.findings = { refundAsked: true };
  await finishWidgetRun(
    failed.run,
    "widget-session-failed",
    { status: "failed" },
    failed.deps
  );
  assert.equal(failed.run.outcome?.reason, "escalated_to_fixy refund");

  const { deps, run } = harness({ asksForHuman: 0, refund: true });
  deps.markRefund = () => Promise.resolve();
  await send(deps, { mode: "investigate" }, scope, () => {
    throw new Error("session unavailable");
  });
  assert.equal(run.outcome?.reason, "escalated_to_fixy refund");

  setEnv(t, "WIDGET_NEXT_ACTION", "jev");
  const asked = harness();
  asked.run.findings = { refundAsked: true };
  asked.deps.extract = () => Promise.resolve(null);
  const text =
    "Billing shows two $252 charges in October, one refunded. Which charge do they mean?";
  await finishWidgetRun(
    asked.run,
    "widget-session-asked",
    {
      afterReads: true,
      asked: "Which charge do you mean?",
      findings: null,
      status: "completed",
      text,
    },
    asked.deps
  );
  assert.equal(asked.run.outcome?.reason, "escalated_to_fixy refund");
  assert.equal((asked.run.findings as WidgetFindings).recommendation, text);
});
