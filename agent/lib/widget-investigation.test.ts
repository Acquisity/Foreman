import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { isUnattended } from "./trust.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { GateResult } from "./widget-egress.js";
import type { WidgetFindings } from "./widget-findings.js";
import {
  failWidgetRun,
  receiveWidgetMessage,
  WIDGET_DEADLINE_MS,
  type WidgetDependencies,
  waitForWidgetInvestigation,
  withHistory,
} from "./widget-investigation.js";
import type { KbAnswer } from "./widget-kb.js";
import type { WidgetRun } from "./widget-run-store.js";
import { WIDGET_SUPPORT_ISSUER } from "./widget-scope.js";

const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const findings: WidgetFindings = {
  confidence: "high",
  facts: [
    {
      claim: "The campaign paused after its inbox disconnected.",
      entityIds: [],
      evidence: { ref: "row-1", tool: "planetscale_execute_read_query" },
    },
  ],
  needsHuman: false,
  recommendation: "Reconnect the inbox.",
  report:
    "The sending inbox is disconnected. Have the customer reconnect it and the campaign resumes.",
};
const allowed: GateResult = {
  decision: "allow",
  findings,
  message: "Your inbox disconnected. Reconnect it and the campaign resumes.",
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
const enabled = (t: TestContext) => setEnv(t, "SUPPORT_CHAT_ENABLED", "true");

function dependencies(gateResult: GateResult = allowed) {
  const run: WidgetRun = {
    completed_at: null,
    created_at: new Date(),
    decision: null,
    findings: null,
    id: runId,
    outcome: null,
    question: "Why did my campaign stop sending?",
    scope,
    session_id: null,
    stream_index: 0,
  };
  const gated: unknown[] = [];
  const deps: WidgetDependencies = {
    answerChat: () => assert.fail("must not reply as small talk"),
    answerKb: () => assert.fail("must not answer from the help center"),
    attach: (_id, sessionId, streamIndex) => {
      run.session_id = sessionId;
      run.stream_index = streamIndex;
      return Promise.resolve();
    },
    claim: () => Promise.resolve({ fresh: true, run }),
    claimFinish: () => Promise.resolve(true),
    complete: (_id, outcome, stored) => {
      run.outcome = outcome;
      run.findings = stored;
      run.completed_at = new Date();
      return Promise.resolve(run);
    },
    extract: () => Promise.resolve(findings),
    gate: (_scope, _question, raw) => {
      gated.push(raw);
      return Promise.resolve(gateResult);
    },
    history: () => Promise.resolve([]),
    latestScope: () => Promise.resolve(null),
    read: () => Promise.resolve(run),
    route: () =>
      Promise.resolve({
        asksForAction: 0,
        asksForHuman: 0,
        asksOwnData: 1,
        confidence: 0,
        kbScore: 0,
        lane: "investigate",
        source: "fallback",
      }),
    verifyAccess: () =>
      Promise.resolve({
        domains: new Set<string>(),
        emails: new Set<string>(),
        slugs: new Set<string>(),
        uuids: new Set<string>(),
      }),
  };
  return { deps, gated, run };
}

const request = (
  body: unknown,
  authorization = "Bearer signed.user.identity"
) =>
  new Request("https://foreman.example/internal/widget/message", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });
const start = {
  conversation_id: scope.conversationId,
  organization_id: scope.organizationId,
  question: "Why did my campaign stop sending?",
};

type EventStream = Awaited<ReturnType<Session["getEventStream"]>>;
type StreamEvent =
  EventStream extends ReadableStream<infer Event> ? Event : never;
const event = (type: string, data: unknown = {}) =>
  ({ data, type }) as unknown as StreamEvent;
const session = (events: StreamEvent[], id = "widget-session-1") =>
  ({
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream<StreamEvent>({
          start(controller) {
            for (const item of events) {
              controller.enqueue(item);
            }
            controller.close();
          },
        })
      ),
    id,
  }) as unknown as Session;
const completedSession = (id = "widget-session-1") =>
  session(
    [
      event("message.completed", {
        finishReason: "stop",
        message: "The inbox disconnected; reconnect it to resume sending.",
      }),
      event("session.completed"),
    ],
    id
  );

const verify = () => Promise.resolve(scope);
const noWork = (): Pick<RouteHandlerArgs, "from" | "waitUntil"> => ({
  from: () => assert.fail("must not start a session"),
  waitUntil: () => assert.fail("must not start background work"),
});

test("disabled, unauthenticated, malformed and oversized requests stop before verification", async (t) => {
  const verified = () => assert.fail("must not verify");
  const { deps } = dependencies();
  const response = await receiveWidgetMessage(
    request(start),
    noWork(),
    1,
    verified,
    deps
  );
  assert.equal(response.status, 404);
  enabled(t);
  assert.equal(
    (
      await receiveWidgetMessage(
        request(start, ""),
        noWork(),
        1,
        verified,
        deps
      )
    ).status,
    401
  );
  assert.equal(
    (
      await receiveWidgetMessage(
        request({ ...start, extra: 1 }),
        noWork(),
        1,
        verified,
        deps
      )
    ).status,
    400
  );
  assert.equal(
    (
      await receiveWidgetMessage(
        request("not json"),
        noWork(),
        1,
        verified,
        deps
      )
    ).status,
    400
  );
  assert.equal(
    (
      await receiveWidgetMessage(
        request({ ...start, question: "x".repeat(9000) }),
        noWork(),
        1,
        verified,
        deps
      )
    ).status,
    413
  );
});

test("an unverified workspace starts nothing", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  const response = await receiveWidgetMessage(
    request(start),
    noWork(),
    1,
    () => Promise.reject(new Error("denied")),
    deps
  );
  assert.equal(response.status, 403);
});

test("a changed identity on an existing conversation is refused, not continued", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  deps.latestScope = () =>
    Promise.resolve({
      ...scope,
      userId: "99999999-9999-4999-8999-999999999999",
    });
  deps.claim = () => assert.fail("drift must not claim a run");
  const response = await receiveWidgetMessage(
    request(start),
    noWork(),
    1,
    verify,
    deps
  );
  assert.equal(response.status, 403);
});

test("a scope whose user is not a member of the workspace is refused before any investigation starts", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  deps.verifyAccess = () => Promise.reject(new Error("not a member"));
  const response = await receiveWidgetMessage(
    request(start),
    {
      from: () => assert.fail("a mismatched owner must not reach a session"),
      waitUntil: () => undefined,
    } as never,
    1,
    verify,
    deps
  );
  assert.equal(response.status, 403);
  // Terminal, so the conversation's next message is not handed this run.
  assert.equal(run.outcome?.reason, "workspace_access_denied");
});

test("a follow-up sent while an earlier message is still running is told to wait, never handed that run's answer", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  deps.claim = () => Promise.resolve({ busy: true, fresh: false, run });
  const response = await receiveWidgetMessage(
    request({ ...start, question: "Check inbox health too." }),
    {
      from: () => assert.fail("a waiting message must not start a session"),
      waitUntil: () => undefined,
    } as never,
    1,
    verify,
    deps
  );
  assert.deepEqual(await response.json(), { run_id: run.id, status: "busy" });
});

test("a completed investigation is gated, answered with the composed reply, and returns its findings for the inbox note", async (t) => {
  enabled(t);
  const { deps, gated, run } = dependencies();
  const sends: {
    auth: unknown;
    message: string;
    options: Record<string, unknown>;
  }[] = [];
  const response = await receiveWidgetMessage(
    request({ ...start, message_id: "66666666-6666-4666-8666-666666666666" }),
    {
      from: (address) => {
        assert.equal(
          address,
          `${scope.organizationId}:${scope.conversationId}`
        );
        return {
          send: (message: string, options: { auth: unknown }) => {
            sends.push({
              auth: options.auth,
              message,
              options: options as Record<string, unknown>,
            });
            return Promise.resolve(completedSession());
          },
        } as unknown as ReturnType<RouteHandlerArgs["from"]>;
      },
      waitUntil: () => undefined,
    },
    200,
    verify,
    deps
  );
  const [sent] = sends;
  const auth = sent.auth as {
    issuer: string;
    attributes: Record<string, string>;
  };
  assert.equal(sent.message, start.question);
  assert.equal(auth.issuer, WIDGET_SUPPORT_ISSUER);
  assert.equal(isUnattended(auth as never), true);
  assert.equal(auth.attributes.organizationId, scope.organizationId);
  assert.equal(sent.options.mode, "task");
  assert.equal(sent.options.outputSchema, undefined);
  assert.deepEqual(gated, [findings]);
  assert.deepEqual(await response.json(), {
    decision: "allow",
    findings,
    message: allowed.message,
    run_id: runId,
    status: "completed",
  });
  assert.equal(run.session_id, "widget-session-1");
});

const kbRoute = (confidence: number) => () =>
  Promise.resolve({
    asksForAction: 0,
    asksForHuman: 0,
    asksOwnData: 0,
    confidence,
    kbScore: confidence,
    lane: "kb" as const,
    source: "jev" as const,
  });
const kbAnswer = {
  citations: [
    { n: 1, title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
  ],
  message: "Connect your calendar first [1].",
};

test("a confident knowledge-base route answers with citations and never starts a session or the gate", async (t) => {
  enabled(t);
  const { deps, gated, run } = dependencies();
  deps.route = kbRoute(0.98);
  deps.answerKb = () => Promise.resolve(kbAnswer);
  const response = await receiveWidgetMessage(
    request({ ...start, message_id: "77777777-7777-4777-8777-777777777777" }),
    noWork(),
    200,
    verify,
    deps
  );
  assert.deepEqual(await response.json(), {
    citations: kbAnswer.citations,
    decision: "allow",
    message: kbAnswer.message,
    run_id: runId,
    status: "completed",
  });
  assert.deepEqual(gated, []);
  assert.equal(run.outcome?.reason, "kb");
});

test("a request to act skips the investigation, and an ask for a person hands off at once without one", async (t) => {
  enabled(t);
  const route = (lane: "investigate" | "human") => () =>
    Promise.resolve({
      asksForAction: 0.95,
      asksForHuman: lane === "human" ? 0.95 : 0,
      asksOwnData: 0.97,
      confidence: 0.4,
      kbScore: 0,
      lane,
      source: "jev" as const,
    });
  const { deps, gated } = dependencies();
  deps.route = route("investigate");
  deps.answerKb = () => Promise.resolve(kbAnswer);
  const acted = await receiveWidgetMessage(
    request({ ...start, message_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
    noWork(),
    200,
    verify,
    deps
  );
  const body = (await acted.json()) as Record<string, unknown>;
  assert.equal(body.message, kbAnswer.message);
  assert.deepEqual(gated, []);

  const human = dependencies();
  human.deps.route = route("human");
  human.deps.answerKb = () =>
    assert.fail("an explicit ask for a person is not fast-laned");
  const handed = await receiveWidgetMessage(
    request({ ...start, message_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" }),
    noWork(),
    200,
    verify,
    human.deps
  );
  const handedBody = (await handed.json()) as {
    decision: string;
    findings: { needsHuman: boolean };
    message: string | null;
  };
  assert.equal(handedBody.decision, "block");
  assert.equal(handedBody.message, null);
  assert.equal(handedBody.findings.needsHuman, true);
  assert.deepEqual(human.gated, []);
  assert.equal(human.run.outcome?.reason, "asked_for_human");
});

test("a thank you gets a sentence back, and is investigated only if that reply cannot be written", async (t) => {
  enabled(t);
  const chatRoute = () =>
    Promise.resolve({
      asksForAction: 0,
      asksForHuman: 0,
      asksOwnData: 0.9,
      confidence: 0.97,
      kbScore: 0,
      lane: "chat" as const,
      source: "jev" as const,
    });
  const { deps, gated, run } = dependencies();
  deps.route = chatRoute;
  deps.answerChat = () =>
    Promise.resolve({ citations: [], message: "You're welcome!" });
  const response = await receiveWidgetMessage(
    request({ ...start, message_id: "cccccccc-3333-4333-8333-cccccccccccc" }),
    noWork(),
    200,
    verify,
    deps
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.message, "You're welcome!");
  assert.equal(body.citations, undefined);
  assert.equal(run.outcome?.reason, "chat");
  assert.deepEqual(gated, []);

  const failing = dependencies();
  failing.deps.route = chatRoute;
  failing.deps.answerChat = () => Promise.resolve(null);
  await receiveWidgetMessage(
    request({ ...start, message_id: "dddddddd-4444-4444-8444-dddddddddddd" }),
    {
      from: () =>
        ({
          send: () => Promise.resolve(completedSession()),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    200,
    verify,
    failing.deps
  );
  assert.deepEqual(failing.gated, [findings]);
});

const routeWith =
  (lane: "investigate", kbScore: number, confidence = 0.55) =>
  () =>
    Promise.resolve({
      asksForAction: 0,
      asksForHuman: 0,
      asksOwnData: 0.8,
      confidence,
      kbScore,
      lane,
      source: "jev" as const,
    });

test("the help center gets the first try when it is the router's pick however unsure, or a close second", async (t) => {
  enabled(t);
  for (const route of [kbRoute(0.39), routeWith("investigate", 0.5)]) {
    const { deps, gated, run } = dependencies();
    deps.route = route;
    deps.answerKb = () => Promise.resolve(kbAnswer);
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: "99999999-9999-4999-8999-999999999999" }),
      {
        from: () => {
          throw new Error("the fast lane must not start a session");
        },
        waitUntil: () => undefined,
      },
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.message, kbAnswer.message);
    assert.deepEqual(gated, []);
    assert.equal(run.outcome?.reason, "kb");
  }
});

test("an unsure help-center miss or a distant second is investigated instead", async (t) => {
  enabled(t);
  for (const [route, answer] of [
    [kbRoute(0.4), null],
    // An investigate pick the router is sure of never detours through the help center.
    [routeWith("investigate", 0.1, 0.96), kbAnswer],
  ] as const) {
    const { deps, gated } = dependencies();
    deps.route = route;
    deps.answerKb = () => Promise.resolve(answer);
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: "88888888-8888-4888-8888-888888888888" }),
      {
        from: () =>
          ({
            send: () => Promise.resolve(completedSession()),
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.message, allowed.message);
    assert.equal(body.citations, undefined);
    assert.deepEqual(gated, [findings]);
  }
});

test('a follow-up reaches the router and the fast lane with the earlier turns, so "that" can be resolved', async (t) => {
  enabled(t);
  const history = [
    { role: "customer" as const, text: "how do i add new inboxes?" },
    { role: "assistant" as const, text: "Open Email Accounts [1]." },
  ];
  assert.equal(withHistory("where is that?", []), "where is that?");
  const { deps } = dependencies();
  const seen: unknown[] = [];
  deps.route = (ask) => {
    seen.push(ask);
    return kbRoute(0.98)();
  };
  deps.answerKb = (ask) => {
    seen.push(ask);
    return Promise.resolve(kbAnswer);
  };
  const response = await receiveWidgetMessage(
    request({
      ...start,
      history,
      message_id: "99999999-9999-4999-8999-999999999999",
      question: "where is that?",
    }),
    noWork(),
    200,
    verify,
    deps
  );
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  for (const ask of seen as { latest: string; turns: unknown[] }[]) {
    // The latest message stands apart from the turns that only give it context.
    assert.equal(ask.latest, "where is that?");
    assert.deepEqual(ask.turns, history);
  }
});

const followUpRoute =
  (followUp: number, confidence = 0.9) =>
  () =>
    Promise.resolve({
      ...followUpBase,
      confidence,
      followUp,
      kbScore: confidence,
    });
const followUpBase = {
  asksForAction: 0,
  asksForHuman: 0,
  asksOwnData: 0,
  lane: "kb" as const,
  source: "jev" as const,
};
const cited = [
  { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
];

test("the previous reply's citations reach the fast lane, flagged as a follow-up only when the router says so", async (t) => {
  enabled(t);
  const history = [
    { role: "customer" as const, text: "how do i set up ai sdr?" },
    {
      citations: cited,
      role: "assistant" as const,
      text: "Connect a calendar.",
    },
  ];
  for (const [asked, score, expected] of [
    ["okay, what next?", 0.95, true],
    ["how do i buy a domain?", 0.05, false],
  ] as const) {
    const { deps } = dependencies();
    deps.route = followUpRoute(score);
    let got: unknown;
    deps.answerKb = (ask) => {
      got = ask;
      return Promise.resolve(kbAnswer);
    };
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await receiveWidgetMessage(
      request({
        ...start,
        history,
        message_id: crypto.randomUUID(),
        question: asked,
      }),
      noWork(),
      200,
      verify,
      deps
    );
    const sent = got as { activeArticles: unknown; followUp: boolean };
    assert.deepEqual(sent.activeArticles, cited);
    assert.equal(sent.followUp, expected);
  }
});

test("malformed citation history is dropped, not a reason to refuse the message", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  deps.route = followUpRoute(0.95);
  let got: unknown;
  deps.answerKb = (ask) => {
    got = ask;
    return Promise.resolve(kbAnswer);
  };
  const response = await receiveWidgetMessage(
    request({
      ...start,
      history: [
        {
          citations: [{ url: 7 }],
          role: "assistant",
          text: "Connect a calendar.",
        },
      ],
      message_id: crypto.randomUUID(),
      question: "and then?",
    }),
    noWork(),
    200,
    verify,
    deps
  );
  assert.equal(response.status, 200);
  assert.deepEqual((got as { activeArticles: unknown }).activeArticles, []);
});

test("a confident help-center question that misses gets a clarifying reply: no investigation, no handoff, never blank", async (t) => {
  enabled(t);
  for (const clarify of [
    () =>
      Promise.resolve({
        citations: [],
        message: "Which feature is this about?",
      }),
    () => Promise.resolve(null),
    () => Promise.reject(new Error("timeout")),
  ]) {
    const { deps, gated, run } = dependencies();
    deps.route = followUpRoute(0, 0.9);
    deps.answerKb = () => Promise.resolve(null);
    deps.answerChat = clarify;
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: crypto.randomUUID() }),
      noWork(),
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.decision, "allow");
    assert.equal(body.status, "completed");
    assert.ok(typeof body.message === "string" && body.message.length > 0);
    assert.equal(body.citations, undefined);
    assert.equal(body.findings, undefined);
    assert.equal(run.outcome?.reason, "kb_miss");
    assert.equal(run.session_id, null);
    assert.deepEqual(gated, []);
  }
});

test("the replies written at the front door read the latest message first with four bounded turns, never the full transcript", async (t) => {
  enabled(t);
  const history = Array.from({ length: 8 }, (_, n) => ({
    role: n % 2 ? ("assistant" as const) : ("customer" as const),
    text: `turn ${n} about growth plans`,
  }));
  const chatRoute = () =>
    Promise.resolve({
      ...followUpBase,
      confidence: 0.9,
      kbScore: 0,
      lane: "chat" as const,
    });
  const unclearRoute = () =>
    Promise.resolve({
      ...followUpBase,
      confidence: 0.2,
      kbScore: 0,
      lane: "investigate" as const,
      unclear: 0.95,
    });
  for (const route of [followUpRoute(0, 0.9), chatRoute, unclearRoute]) {
    const { deps } = dependencies();
    deps.route = route;
    deps.answerKb = () => Promise.resolve(null);
    let prompt = "";
    deps.answerChat = (message) => {
      prompt = message;
      return Promise.resolve({ citations: [], message: "ok" });
    };
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    await receiveWidgetMessage(
      request({
        ...start,
        history,
        message_id: crypto.randomUUID(),
        question: "how do i pause a campaign?",
      }),
      noWork(),
      200,
      verify,
      deps
    );
    assert.ok(prompt.startsWith("LATEST CUSTOMER MESSAGE"));
    assert.ok(
      prompt.indexOf("how do i pause a campaign?") < prompt.indexOf("turn 4")
    );
    assert.ok(prompt.includes("turn 7"));
    assert.ok(!prompt.includes("turn 3"), "only four earlier turns ride along");
  }
});

test("a miss the router was unsure about, or an account question, still investigates", async (t) => {
  enabled(t);
  for (const route of [
    followUpRoute(0, 0.4),
    () =>
      Promise.resolve({
        ...followUpBase,
        asksOwnData: 0.95,
        confidence: 0.9,
        kbScore: 0.55,
        lane: "investigate" as const,
      }),
  ]) {
    const { deps, gated } = dependencies();
    deps.route = route;
    deps.answerKb = () => Promise.resolve(null);
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: crypto.randomUUID() }),
      {
        from: () =>
          ({
            send: () => Promise.resolve(completedSession()),
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      200,
      verify,
      deps
    );
    assert.equal(response.status, 200);
    assert.deepEqual(gated, [findings]);
  }
});

test("a blocked investigation returns the raw findings and no customer message", async (t) => {
  enabled(t);
  const blocked: GateResult = {
    decision: "block",
    findings,
    message: null,
    reason: "foreign_identifier:x",
  };
  const { deps } = dependencies(blocked);
  const response = await receiveWidgetMessage(
    request(start),
    {
      from: () =>
        ({
          send: () => Promise.resolve(completedSession()),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    200,
    verify,
    deps
  );
  assert.deepEqual(await response.json(), {
    decision: "block",
    findings,
    message: null,
    // Our own guard blocked it: the app asks for a resend, not a teammate.
    retry: true,
    run_id: runId,
    status: "completed",
  });
});

test("a finished investigation is finished by one caller: the other reports pending, and an unreadable claim still finishes", async (t) => {
  enabled(t);
  const poll = (deps: WidgetDependencies) =>
    receiveWidgetMessage(
      request({
        action: "result",
        conversation_id: scope.conversationId,
        organization_id: scope.organizationId,
        run_id: runId,
      }),
      { attachSession: () => completedSession(), ...noWork() },
      100,
      verify,
      deps
    );
  const claimed = dependencies();
  claimed.run.session_id = "widget-session-1";
  claimed.deps.claimFinish = () => Promise.resolve(false);
  claimed.deps.extract = () =>
    assert.fail("the claimed run must not be finished again");
  assert.equal((await (await poll(claimed.deps)).json()).status, "pending");
  assert.deepEqual(claimed.gated, []);
  assert.equal(claimed.run.outcome, null);

  const unreadable = dependencies();
  unreadable.run.session_id = "widget-session-1";
  unreadable.deps.claimFinish = () => Promise.reject(new Error("no column"));
  assert.equal(
    (await (await poll(unreadable.deps)).json()).status,
    "completed"
  );
  assert.deepEqual(unreadable.gated, [findings]);
});

test("a slow investigation answers pending, then the result action recovers the gated outcome", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  const pendingResponse = await receiveWidgetMessage(
    request(start),
    {
      from: () =>
        ({
          send: () => Promise.resolve(session([], "widget-session-2")),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    1,
    verify,
    deps
  );
  assert.deepEqual(await pendingResponse.json(), {
    run_id: runId,
    status: "pending",
  });
  assert.equal(run.outcome, null);
  const result = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    {
      attachSession: (id) => {
        assert.equal(id, "widget-session-2");
        return completedSession();
      },
      ...noWork(),
    },
    100,
    verify,
    deps
  );
  assert.equal((await result.json()).status, "completed");
  assert.equal((run.outcome as { decision: string } | null)?.decision, "allow");
});

test("a result read from another user or a duplicate start never starts work", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  const other = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    noWork(),
    1,
    () =>
      Promise.resolve({
        ...scope,
        userId: "99999999-9999-4999-8999-999999999999",
      }),
    deps
  );
  assert.equal(other.status, 503);
  deps.claim = async () => ({ fresh: false, run: await deps.read(runId) });
  const duplicate = await receiveWidgetMessage(
    request(start),
    noWork(),
    1,
    verify,
    deps
  );
  assert.deepEqual(await duplicate.json(), {
    run_id: runId,
    status: "pending",
  });
});

test("a finish with no prose at all blocks with no findings", async (t) => {
  enabled(t);
  const { deps, gated } = dependencies();
  const response = await receiveWidgetMessage(
    request(start),
    {
      from: () =>
        ({
          send: () => Promise.resolve(session([event("session.completed")])),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    200,
    verify,
    deps
  );
  const body = await response.json();
  assert.deepEqual(
    [body.decision, body.message, body.findings],
    ["block", null, null]
  );
  assert.equal(gated.length, 0);
});

test("a failed session blocks its run once", async () => {
  const { deps, run } = dependencies();
  run.session_id = "widget-session-3";
  await failWidgetRun(runId, "widget-session-3", deps);
  assert.deepEqual(run.outcome, {
    decision: "block",
    message: null,
    reason: "session_failed",
    status: "failed",
  });
  deps.complete = () => assert.fail("a completed run is immutable");
  await failWidgetRun(runId, "widget-session-3", deps);
});

test("a filed ticket is taken from the tool's own result, whatever the write-up says", async () => {
  const ticketResult = (output: unknown, extra: object = {}) =>
    event("action.result", {
      result: {
        callId: "call-1",
        kind: "tool-result",
        output,
        toolName: "widget_file_ticket",
        ...extra,
      },
    });
  const url = "https://linear.app/acquisity/issue/ENG-14067/pre-warmed";
  const outcome = await waitForWidgetInvestigation(
    session([
      ticketResult({ existing: false, identifier: "ENG-14067", url }),
      event("message.completed", { message: "Engineering ticket filed." }),
      event("session.completed"),
    ])
  );
  assert.deepEqual(outcome.status === "completed" && outcome.ticket, {
    id: "ENG-14067",
    url,
  });
  // A failed call, a mismatched link and another tool's output are never a ticket.
  const refused = await Promise.all(
    [
      ticketResult({ error: "Linear did not accept the ticket." }),
      ticketResult({ identifier: "ENG-1", url }),
      ticketResult({ identifier: "ENG-14067", url }, { isError: true }),
      ticketResult({ identifier: "ENG-14067", url }, { toolName: "other" }),
    ].map((result) =>
      waitForWidgetInvestigation(session([result, event("session.completed")]))
    )
  );
  for (const none of refused) {
    assert.equal(none.status === "completed" && none.ticket, null);
  }
});

test("stream observation starts at the turn's index, resets on a new turn, and reports a timeout as pending", async () => {
  const indexes: number[] = [];
  const stream = (events: StreamEvent[]) =>
    ({
      getEventStream: (options?: { startIndex?: number }) => {
        indexes.push(options?.startIndex ?? -1);
        return session(events).getEventStream();
      },
    }) as Pick<Session, "getEventStream">;
  const outcome = await waitForWidgetInvestigation(
    stream([
      event("result.completed", { result: findings }),
      event("turn.started"),
      event("result.completed", { result: { bad: true } }),
      event("session.completed"),
    ]),
    7
  );
  assert.deepEqual(outcome, {
    findings: null,
    status: "completed",
    text: null,
    ticket: null,
  });
  assert.deepEqual(indexes, [7]);
  const open = {
    getEventStream: () => Promise.resolve(new ReadableStream<StreamEvent>()),
  } as Pick<Session, "getEventStream">;
  assert.deepEqual(await waitForWidgetInvestigation(open, 0, 5), {
    status: "pending",
  });
});

test("a finish the extractor cannot structure hands the prose to a human", async (t) => {
  enabled(t);
  const { deps, gated } = dependencies();
  deps.extract = () => Promise.resolve(null);
  const prose =
    "Your sending inbox looks disconnected, so nothing is going out right now.";
  const proseSession = session([
    event("message.completed", { finishReason: "stop", message: prose }),
    event("session.completed"),
  ]);
  const response = await receiveWidgetMessage(
    request(start),
    {
      from: () =>
        ({
          send: () => Promise.resolve(proseSession),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    200,
    verify,
    deps
  );
  const body = await response.json();
  assert.equal(body.decision, "block");
  assert.equal(body.message, null);
  assert.equal(body.status, "completed");
  assert.equal(body.findings.needsHuman, true);
  assert.equal(body.findings.report, prose);
  assert.equal(gated.length, 0);
});

test("an overdue run with no answer is force-finished for a human, not left hanging", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  run.session_id = "widget-session-old";
  run.created_at = new Date(Date.now() - WIDGET_DEADLINE_MS - 1000);
  const result = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    {
      attachSession: () => session([], "widget-session-old"),
      ...noWork(),
    },
    5,
    verify,
    deps
  );
  const body = await result.json();
  assert.equal(body.decision, "block");
  assert.equal(body.status, "completed");
  assert.equal(body.findings.needsHuman, true);
  assert.equal((run.outcome as { reason: string } | null)?.reason, "deadline");
});

test("an unclear message gets one clarifying question instead of an investigation", async (t) => {
  enabled(t);
  const { deps, gated, run } = dependencies();
  deps.route = () =>
    Promise.resolve({
      asksForAction: 0,
      asksForHuman: 0,
      asksOwnData: 0.7,
      confidence: 0.6,
      kbScore: 0.1,
      lane: "investigate" as const,
      source: "jev" as const,
      unclear: 0.93,
    });
  let system: string | undefined;
  deps.answerChat = (_message, _log, prompt) => {
    system = prompt;
    return Promise.resolve({
      citations: [],
      message: "Which limit do you mean?",
    });
  };
  const response = await receiveWidgetMessage(
    request({ ...start, message_id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee" }),
    noWork(),
    200,
    verify,
    deps
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.message, "Which limit do you mean?");
  assert.equal(run.outcome?.reason, "clarify");
  assert.ok(system && system !== undefined);
  assert.deepEqual(gated, []);
});

test("a teammate's inbox run skips the front door, verifies as staff, and keeps its own session", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  const inbox = { ...scope, source: "inbox" as const };
  run.scope = inbox;
  deps.route = () => assert.fail("must not route a teammate's request");
  let verifiedAsStaff: boolean | undefined;
  let address = "";
  const response = await receiveWidgetMessage(
    request({ ...start, question: "can i speak with a human", staff: true }),
    {
      from: (to: string) => {
        address = to;
        return { send: () => Promise.resolve(completedSession()) };
      },
      waitUntil: () => undefined,
    } as unknown as Pick<RouteHandlerArgs, "from" | "waitUntil">,
    200,
    (input) => {
      verifiedAsStaff = input.staff;
      return Promise.resolve(inbox);
    },
    deps
  );
  assert.equal(response.status, 200);
  assert.equal(verifiedAsStaff, true);
  assert.equal(
    address,
    `${scope.organizationId}:${scope.conversationId}:inbox`
  );

  // The customer's own token never reads a teammate's run.
  const read = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    noWork(),
    200,
    verify,
    deps
  );
  assert.equal(read.status, 503);
});

// Router scores are the ones production logged for these turns (2026-09-20,
// conversations a78ebd97 and 869b6831); both turns were investigated, blocked
// at the gate and left the thread in human takeover.
const loggedRoute = (latest: string) => {
  const base = {
    asksForAction: 0.1,
    asksForHuman: 0.02,
    asksOwnData: 0.3,
    source: "jev" as const,
  };
  if (latest.startsWith("Now Google says")) {
    return {
      ...base,
      asksOwnData: 0.9,
      confidence: 0.61,
      followUp: 0.04,
      kbScore: 0.29,
      lane: "investigate" as const,
      unclear: 0.46,
    };
  }
  if (latest === "and my dashboard totals") {
    return {
      ...base,
      asksOwnData: 0.77,
      confidence: 0.51,
      followUp: 0.12,
      kbScore: 0.33,
      lane: "investigate" as const,
      unclear: 0.66,
    };
  }
  if (latest === "okay thanks") {
    return { ...base, confidence: 0.95, kbScore: 0, lane: "chat" as const };
  }
  return { ...base, confidence: 0.95, kbScore: 0.95, lane: "kb" as const };
};

const docs = (slug: string) => `https://app.acquisity.ai/docs/${slug}`;
const GOOGLE_BLOCKED =
  "account-settings/faq/google-is-blocking-sign-in-when-connecting-my-email-and-calendar";
const DASHBOARD_TOTALS =
  "dashboard/faq/why-dont-dashboard-and-per-campaign-totals-match";
const SDR_KB =
  "ai-sdr/faq/inbox-replies/where-do-i-find-the-ai-sdr-knowledge-base-in-the-app";

/** What the lane reports for a message that does not yet say what is wanted. */
const FRAGMENT = "fragment";

/** Replay one persistent conversation through the front door, turn by turn. */
async function replayThread(
  turns: string[],
  article: (latest: string) => string | null
) {
  const history: {
    citations?: { title: string; url: string }[];
    role: "assistant" | "customer";
    text: string;
  }[] = [];
  const seen: { cited: string[]; message: unknown; reason?: string }[] = [];
  for (const latest of turns) {
    const { deps, gated, run } = dependencies();
    deps.route = (ask) =>
      Promise.resolve(loggedRoute(typeof ask === "string" ? ask : ask.latest));
    deps.answerKb = (ask) => {
      const slug = article(typeof ask === "string" ? ask : ask.latest);
      if (slug === FRAGMENT) {
        return Promise.resolve({ citations: [], message: "", unclear: true });
      }
      return Promise.resolve(
        slug
          ? {
              citations: [{ n: 1, title: slug, url: docs(slug) }],
              message: `From ${slug}.`,
            }
          : null
      );
    };
    deps.answerChat = () =>
      Promise.resolve({ citations: [], message: "Which totals do you mean?" });
    // biome-ignore lint/performance/noAwaitInLoops: turns of one thread run in order.
    const response = await receiveWidgetMessage(
      request({
        ...start,
        history,
        message_id: crypto.randomUUID(),
        question: latest,
      }),
      // No session may start: an investigation is what ended in the takeover.
      noWork(),
      200,
      verify,
      deps
    );
    const body = (await response.json()) as {
      citations?: { url: string }[];
      message: unknown;
    };
    assert.deepEqual(gated, []);
    assert.equal(run.outcome?.decision, "allow", latest);
    assert.equal(
      (run.findings as WidgetFindings | null)?.needsHuman,
      undefined
    );
    const urls = (body.citations ?? []).map((c) => c.url);
    seen.push({
      cited: urls,
      message: body.message,
      reason: run.outcome?.reason,
    });
    history.push(
      { role: "customer", text: latest },
      {
        citations: urls.map((url) => ({ title: url, url })),
        role: "assistant",
        text: String(body.message),
      }
    );
  }
  return seen;
}

test("thread: a Google blocked-app question after a password-reset thread is answered from its own article, and the thread keeps getting replies", async (t) => {
  enabled(t);
  const seen = await replayThread(
    [
      "My password reset email never showed up. What should I check first?",
      "Spam is empty too. What next?",
      "Now Google says the app is blocked when I connect Email and Calendar.",
      "It is the Google blocked-app warning. What do I click next?",
      "okay thanks",
    ],
    (latest) => (latest.includes("Google") ? GOOGLE_BLOCKED : "auth/reset")
  );
  assert.deepEqual(seen[2].cited, [docs(GOOGLE_BLOCKED)]);
  assert.deepEqual(seen[3].cited, [docs(GOOGLE_BLOCKED)]);
  assert.ok(seen.every((turn) => typeof turn.message === "string"));
});

test("thread: an incomplete fragment gets a clarifying question, its completion the dashboard article, and a jump to the AI SDR knowledge base a fresh one", async (t) => {
  enabled(t);
  const seen = await replayThread(
    [
      "the forgot-password email",
      "never arrived... what should I check first?",
      "and my dashboard totals",
      "do not match the campaign numbers... why can that happen?",
      "also the AI SDR knowledge base",
      "where do I find it in the app?",
    ],
    (latest) => {
      if (latest === "and my dashboard totals") {
        return FRAGMENT;
      }
      if (latest.startsWith("do not match")) {
        return DASHBOARD_TOTALS;
      }
      return latest.includes("AI SDR") || latest.startsWith("where do I")
        ? SDR_KB
        : "auth/reset";
    }
  );
  assert.equal(seen[2].reason, "clarify");
  assert.deepEqual(seen[3].cited, [docs(DASHBOARD_TOTALS)]);
  assert.deepEqual(seen[5].cited, [docs(SDR_KB)]);
  assert.ok(seen.every((turn) => typeof turn.message === "string"));
});

// Scores production logged on FRESH threads (2026-09-20, build fc818fd), where
// no earlier turn lifts the help-center score: both were investigated.
const freshRoute =
  (confidence: number, kbScore: number, unclear: number) => () =>
    Promise.resolve({
      asksForAction: 0.17,
      asksForHuman: 0.04,
      asksOwnData: 0.74,
      confidence,
      kbScore,
      lane: "investigate" as const,
      source: "jev" as const,
      unclear,
    });

test("fresh thread: a documented how-to picked investigate at 0.84 is answered from its article, and a bare fragment is asked what it means, neither touching the account", async (t) => {
  enabled(t);
  const google = {
    citations: [{ n: 1, title: "Google", url: docs(GOOGLE_BLOCKED) }],
    message: "Choose Advanced, then continue.",
  };
  for (const [asked, route, lane, reason, message] of [
    [
      "Now Google says the app is blocked when I connect Email and Calendar.",
      freshRoute(0.84, 0.12, 0.34),
      google,
      "kb",
      google.message,
    ],
    [
      "and my dashboard totals",
      freshRoute(0.64, 0.09, 0.71),
      { citations: [], message: "", unclear: true as const },
      "clarify",
      "Which totals do you mean?",
    ],
  ] as const) {
    const { deps, gated, run } = dependencies();
    deps.route = route;
    let got: { accountLikely?: boolean } | undefined;
    deps.answerKb = (ask) => {
      got = typeof ask === "string" ? {} : ask;
      return Promise.resolve<KbAnswer>({
        ...lane,
        citations: [...lane.citations],
      });
    };
    deps.answerChat = () =>
      Promise.resolve({ citations: [], message: "Which totals do you mean?" });
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: crypto.randomUUID(), question: asked }),
      noWork(),
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(got?.accountLikely, true);
    assert.equal(body.message, message);
    assert.equal(run.outcome?.reason, reason);
    assert.deepEqual(gated, []);
  }
});

test("a genuine account question in the same score range still investigates: the guarded try steps aside, and a sure pick or a ticket request never takes it", async (t) => {
  enabled(t);
  for (const [route, tried] of [
    // "why is my campaign not sending" scores like the Google how-to; the lane says none.
    [freshRoute(0.83, 0.12, 0.57), true],
    [freshRoute(0.96, 0.03, 0.32), false],
    [
      () => freshRoute(0.6, 0, 0)().then((r) => ({ ...r, ticket: true })),
      false,
    ],
  ] as const) {
    const { deps, gated } = dependencies();
    deps.route = route;
    let asked = false;
    deps.answerKb = () => {
      asked = true;
      return Promise.resolve(null);
    };
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: crypto.randomUUID() }),
      {
        from: () =>
          ({
            send: () => Promise.resolve(completedSession()),
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(asked, tried);
    assert.equal(body.message, allowed.message);
    assert.deepEqual(gated, [findings]);
  }
});
