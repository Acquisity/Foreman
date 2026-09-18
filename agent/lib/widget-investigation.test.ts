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
    answerKb: () => assert.fail("must not answer from the help center"),
    attach: (_id, sessionId, streamIndex) => {
      run.session_id = sessionId;
      run.stream_index = streamIndex;
      return Promise.resolve();
    },
    claim: () => Promise.resolve({ fresh: true, run }),
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
    latestScope: () => Promise.resolve(null),
    read: () => Promise.resolve(run),
    route: () =>
      Promise.resolve({
        asksForAction: 0,
        asksForHuman: 0,
        asksOwnData: 1,
        confidence: 0,
        lane: "investigate",
        source: "fallback",
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

test("a completed investigation is gated and answered with the composed reply only", async (t) => {
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

test("a request to act skips the investigation, unless the customer asked for a person", async (t) => {
  enabled(t);
  const route = (lane: "investigate" | "human") => () =>
    Promise.resolve({
      asksForAction: 0.95,
      asksForHuman: lane === "human" ? 0.95 : 0,
      asksOwnData: 0.97,
      confidence: 0.4,
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
  await receiveWidgetMessage(
    request({ ...start, message_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" }),
    {
      from: () =>
        ({
          send: () => Promise.resolve(completedSession()),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    200,
    verify,
    human.deps
  );
  assert.deepEqual(human.gated, [findings]);
});

test("an unsure knowledge-base route, or a help-center miss, is investigated instead", async (t) => {
  enabled(t);
  for (const [confidence, answer] of [
    [0.5, kbAnswer],
    [0.98, null],
  ] as const) {
    const { deps, gated } = dependencies();
    deps.route = kbRoute(confidence);
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
  const seen: string[] = [];
  const { deps } = dependencies();
  deps.route = (message) => {
    seen.push(message);
    return kbRoute(0.98)();
  };
  deps.answerKb = (message) => {
    seen.push(message);
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
  for (const message of seen) {
    assert.ok(message.includes("Customer: how do i add new inboxes?"));
    assert.ok(message.includes("Support: Open Email Accounts [1]."));
    assert.ok(message.endsWith("where is that?"));
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
    run_id: runId,
    status: "completed",
  });
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
