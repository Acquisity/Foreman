import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import { isUnattended } from "./trust.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { GateResult } from "./widget-egress.js";
import { WorkspaceAccessDenied } from "./widget-evidence.js";
import type { WidgetFindings } from "./widget-findings.js";
import {
  failWidgetRun,
  finishWidgetRun,
  REFUND_REDIRECT,
  receiveWidgetMessage,
  WIDGET_DEADLINE_MS,
  type WidgetDependencies,
  waitForWidgetInvestigation,
  widgetRunResponse,
  withHistory,
} from "./widget-investigation.js";
import {
  INVESTIGATE_HINT_FALLBACK,
  INVESTIGATE_HINT_PROMPT,
  type KbAnswer,
} from "./widget-kb.js";
import type { WidgetProgress } from "./widget-progress.js";
import type { WidgetAsk } from "./widget-router.js";
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
const SERVICE_SECRET = "s".repeat(40);
const enabled = (t: TestContext) => {
  setEnv(t, "SUPPORT_CHAT_ENABLED", "true");
  setEnv(t, "FOREMAN_DIAGNOSTICS_SECRET", SERVICE_SECRET);
};

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
    cancel: () => {
      run.outcome = {
        decision: "block",
        message: null,
        reason: "cancelled",
        status: "failed",
      };
      run.completed_at = new Date();
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
    expire: () => assert.fail("a live run must not be expired"),
    expireAll: () => Promise.resolve([]),
    extract: () => Promise.resolve(findings),
    gate: (_scope, _question, raw) => {
      gated.push(raw);
      return Promise.resolve(gateResult);
    },
    handoffEligible: () =>
      assert.fail("eligibility is never checked with the pilot flag off"),
    history: () => Promise.resolve([]),
    latestScope: () => Promise.resolve(null),
    read: () => Promise.resolve(run),
    route: () => Promise.resolve({ asksForHuman: 0, source: "fallback" }),
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

/** Like the app, every new message carries its own id unless the test pins one. */
const withMessageId = (body: unknown) =>
  typeof body === "object" &&
  body !== null &&
  !("action" in body && body.action !== "start") &&
  !("message_id" in body)
    ? { ...body, message_id: crypto.randomUUID() }
    : body;
const request = (
  body: unknown,
  authorization = "Bearer signed.user.identity",
  serviceSecret: string | null = SERVICE_SECRET
) =>
  new Request("https://foreman.example/internal/widget/message", {
    body: typeof body === "string" ? body : JSON.stringify(withMessageId(body)),
    headers: {
      authorization,
      "content-type": "application/json",
      ...(serviceSecret === null
        ? {}
        : { "x-acquisity-service-secret": serviceSecret }),
    },
    method: "POST",
  });
const start = {
  conversation_id: scope.conversationId,
  organization_id: scope.organizationId,
  question: "Why did my campaign stop sending?",
};
/** An owner or admin's message with "Investigate my workspace" turned on. */
const investigate = { ...start, mode: "investigate" as const };

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
        request({ ...start, question: "x".repeat(700_000) }),
        noWork(),
        1,
        verified,
        deps
      )
    ).status,
    413
  );
});

test("a valid conversation at every schema limit is read whole, not refused as too large", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  // Control characters are the worst case: JSON writes each one as six.
  const text = (length: number) => "\u0001".repeat(length);
  const body = JSON.stringify({
    ...start,
    history: Array.from({ length: 12 }, (_, index) => ({
      citations: Array.from({ length: 4 }, () => ({
        title: text(300),
        url: text(500),
      })),
      role: index % 2 ? "assistant" : "customer",
      text: text(4000),
    })),
    images: Array.from(
      { length: 3 },
      (_, index) => `https://shots.example/${index}${"a".repeat(2025)}`
    ),
    message_id: crypto.randomUUID(),
    question: `a${text(3998)}b`,
    screenshots: Array.from({ length: 3 }, () => `a${text(1498)}b`),
  });
  assert.ok(body.length > 8192);
  const response = await receiveWidgetMessage(
    request(body),
    noWork(),
    1,
    () => Promise.reject(new Error("denied")),
    deps
  );
  // Past the body read and the schema, it reaches workspace verification.
  assert.equal(response.status, 403);
});

test("screenshot links reach the help-center lane beside their readings, and only https links are accepted", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  deps.route = kbRoute;
  const asks: WidgetAsk[] = [];
  deps.answerKb = (ask) => {
    asks.push(ask as WidgetAsk);
    return Promise.resolve(kbAnswer);
  };
  const shot = {
    ...start,
    images: ["https://shots.example/one.jpg"],
    question: "where do i go from here?",
    screenshots: ["[Screenshot] Screen: All Campaigns"],
  };
  const response = await receiveWidgetMessage(
    request(shot),
    noWork(),
    200,
    verify,
    deps
  );
  assert.equal(response.status, 200);
  assert.deepEqual(asks.at(-1)?.images, shot.images);
  assert.deepEqual(asks.at(-1)?.screenshots, shot.screenshots);

  const refused = await receiveWidgetMessage(
    request({ ...shot, images: ["http://shots.example/one.jpg"] }),
    noWork(),
    1,
    () => assert.fail("must not verify"),
    deps
  );
  assert.equal(refused.status, 400);
});

test("a widget request without the Acquisity service secret is refused before the identity is checked", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  const unverified = () => assert.fail("must not verify the identity");
  const send = (serviceSecret: string | null) =>
    receiveWidgetMessage(
      request(start, "Bearer signed.user.identity", serviceSecret),
      noWork(),
      1,
      unverified,
      deps
    );
  // Missing, or the customer's own token in its place: the same 403 as an unverified workspace.
  for (const serviceSecret of [
    null,
    "",
    "signed.user.identity",
    `${SERVICE_SECRET}x`,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each header is its own case.
    const refused = await send(serviceSecret);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), {
      error: "Workspace could not be verified.",
    });
  }
  // Foreman without its own secret refuses every request.
  setEnv(t, "FOREMAN_DIAGNOSTICS_SECRET", undefined);
  assert.equal((await send(SERVICE_SECRET)).status, 503);
});

test("with the service secret, a request still needs a verified identity and then proceeds", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  const denied = await receiveWidgetMessage(
    request(start),
    noWork(),
    1,
    () => Promise.reject(new Error("denied")),
    deps
  );
  assert.equal(denied.status, 403);
  deps.claim = () => Promise.resolve({ busy: true, fresh: false, run });
  const proceeds = await receiveWidgetMessage(
    request(start),
    { from: () => assert.fail("busy"), waitUntil: () => undefined } as never,
    1,
    verify,
    deps
  );
  assert.equal(proceeds.status, 200);
  assert.deepEqual(await proceeds.json(), { run_id: run.id, status: "busy" });
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
    request(investigate),
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

test("an owner or admin scope the live database no longer backs is answered in help-center mode, not refused", async (t) => {
  enabled(t);
  const { deps, gated, run } = dependencies();
  deps.verifyAccess = () => Promise.reject(new WorkspaceAccessDenied());
  const asks: WidgetAsk[] = [];
  deps.answerKb = (ask) => {
    asks.push(ask as WidgetAsk);
    return Promise.resolve(kbAnswer);
  };
  const response = await receiveWidgetMessage(
    request(investigate),
    noWork(),
    1,
    verify,
    deps
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.message, kbAnswer.message);
  assert.deepEqual(gated, []);
  assert.equal(run.outcome?.reason, "kb");
  assert.equal(asks.at(-1)?.cannotLook, true);
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

test("a claim that never got a session is settled after the deadline, however old, so the conversation is not blocked for good", async (t) => {
  enabled(t);
  const freshId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const stale = (ageMs: number) => {
    const made = dependencies();
    made.run.created_at = new Date(Date.now() - ageMs);
    const settle: WidgetDependencies["expire"] = (_id, outcome, stored) => {
      made.run.outcome = outcome;
      made.run.findings = stored;
      made.run.completed_at = new Date();
      return Promise.resolve(true);
    };
    made.deps.expire = settle;
    made.deps.expireAll = async (owner, outcome, stored) => {
      assert.equal(owner.conversationId, scope.conversationId);
      assert.equal(owner.source, scope.source);
      await settle(made.run.id, outcome, stored, 0);
      return [made.run.id];
    };
    // The partial unique index: an open run of this conversation holds the slot.
    made.deps.claim = () =>
      Promise.resolve({
        busy: true,
        fresh: false,
        run: made.run.completed_at
          ? { ...made.run, created_at: new Date(), id: freshId, outcome: null }
          : made.run,
      });
    return made;
  };
  for (const ageMs of [200_000, 3 * 60 * 60 * 1000]) {
    // Polling the dead run settles it as a handoff instead of pending forever;
    // past the result window its content is still refused.
    const polled = stale(ageMs);
    // biome-ignore lint/performance/noAwaitInLoops: each age is its own case.
    const result = await receiveWidgetMessage(
      request({
        action: "result",
        conversation_id: scope.conversationId,
        organization_id: scope.organizationId,
        run_id: runId,
      }),
      { attachSession: () => assert.fail("no session to attach"), ...noWork() },
      1,
      verify,
      polled.deps
    );
    assert.equal(result.status, ageMs > 7_200_000 ? 503 : 200, `${ageMs}`);
    assert.equal(polled.run.outcome?.reason, "deadline");
    // A new message is no longer told to wait on it: it claims a run of its own.
    const next = stale(ageMs);
    const started = await receiveWidgetMessage(
      request({ ...start, question: "Is it fixed now?" }),
      {
        from: () => assert.fail("still busy"),
        waitUntil: () => undefined,
      } as never,
      1,
      verify,
      next.deps
    );
    assert.equal(next.run.outcome?.reason, "deadline");
    assert.equal(
      ((await started.json()) as { run_id: string }).run_id,
      freshId,
      `${ageMs}`
    );
  }
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
    request({
      ...investigate,
      message_id: "66666666-6666-4666-8666-666666666666",
    }),
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

const kbRoute = () =>
  Promise.resolve({ asksForHuman: 0, source: "jev" as const });
const kbAnswer = {
  citations: [
    { n: 1, title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
  ],
  message: "Connect your calendar first [1].",
};

test("a confident knowledge-base route answers with citations and never starts a session or the gate", async (t) => {
  enabled(t);
  const { deps, gated, run } = dependencies();
  deps.route = kbRoute;
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
      asksForHuman: lane === "human" ? 0.95 : 0,
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

test("a member or client is answered in help-center mode, never investigated", async (t) => {
  enabled(t);
  for (const role of ["member", "client"] as const) {
    const { deps, gated, run } = dependencies();
    deps.verifyAccess = () =>
      assert.fail("must not check investigation access");
    const asks: WidgetAsk[] = [];
    deps.answerKb = (ask) => {
      asks.push(ask as WidgetAsk);
      return Promise.resolve(kbAnswer);
    };
    // biome-ignore lint/performance/noAwaitInLoops: one role at a time keeps failures readable.
    const response = await receiveWidgetMessage(
      request(start),
      noWork(),
      200,
      () => Promise.resolve({ ...scope, role }),
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.decision, "allow");
    // The default route here is a sure "investigate": help-center mode still answers.
    assert.equal(body.message, kbAnswer.message);
    assert.deepEqual(gated, []);
    assert.equal(run.outcome?.reason, "kb");
    assert.equal(asks.at(-1)?.cannotLook, true);
  }

  const refund = dependencies();
  refund.deps.route = () =>
    Promise.resolve({
      asksForHuman: 0.05,
      refund: true,
      source: "jev",
      ticket: true,
    });
  const redirected = await receiveWidgetMessage(
    request(start),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "member" }),
    refund.deps
  );
  assert.equal(
    ((await redirected.json()) as Record<string, unknown>).message,
    REFUND_REDIRECT
  );
  assert.equal(refund.run.outcome?.reason, "refund_redirect");

  const miss = dependencies();
  miss.deps.answerKb = () => Promise.resolve(null);
  miss.deps.answerChat = () =>
    Promise.resolve({ citations: [], message: "Which feature is this about?" });
  const missed = await receiveWidgetMessage(
    request(start),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "client" }),
    miss.deps
  );
  assert.equal(
    ((await missed.json()) as Record<string, unknown>).message,
    "Which feature is this about?"
  );
  assert.equal(miss.run.outcome?.reason, "kb_miss");

  const kb = dependencies();
  kb.deps.route = () =>
    Promise.resolve({
      asksForHuman: 0,
      source: "jev",
    });
  kb.deps.answerKb = () => Promise.resolve(kbAnswer);
  const answered = await receiveWidgetMessage(
    request(start),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "member" }),
    kb.deps
  );
  assert.equal(
    ((await answered.json()) as Record<string, unknown>).message,
    kbAnswer.message
  );

  const human = dependencies();
  human.deps.route = () =>
    Promise.resolve({
      asksForHuman: 0.95,
      source: "jev",
    });
  await receiveWidgetMessage(
    request(start),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "client" }),
    human.deps
  );
  assert.equal(human.run.outcome?.reason, "asked_for_human");
});

test("a thank you gets a sentence back, and is answered from the help center if that reply cannot be written", async (t) => {
  enabled(t);
  const chatRoute = () =>
    Promise.resolve({
      asksForHuman: 0,
      chat: true,
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
  failing.deps.answerKb = () => Promise.resolve(kbAnswer);
  await receiveWidgetMessage(
    request({ ...start, message_id: "dddddddd-4444-4444-8444-dddddddddddd" }),
    noWork(),
    200,
    verify,
    failing.deps
  );
  assert.deepEqual(failing.gated, []);
  assert.equal(failing.run.outcome?.message, kbAnswer.message);
});

test("a message without the toggle never offers a screen recording, whatever Jev reads", async (t) => {
  enabled(t);
  for (const role of ["owner", "member"] as const) {
    const { deps } = dependencies();
    deps.route = () =>
      Promise.resolve({
        asksForHuman: 0,
        bug: true,
        recording: true,
        source: "jev" as const,
      });
    const asks: WidgetAsk[] = [];
    deps.answerKb = (ask) => {
      asks.push(ask as WidgetAsk);
      return Promise.resolve(kbAnswer);
    };
    deps.requestRecording = () =>
      assert.fail("only an investigation asks for the recording button");
    // biome-ignore lint/performance/noAwaitInLoops: one role at a time keeps failures readable.
    const response = await receiveWidgetMessage(
      request({
        ...start,
        message_id: crypto.randomUUID(),
        question:
          "The save button is broken, can I send you a screen recording?",
      }),
      noWork(),
      200,
      () => Promise.resolve({ ...scope, role }),
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.request_recording, undefined);
    // The writer is told the button does not show, so it never points to one.
    assert.equal(asks.at(-1)?.recordingOffered, false);
  }
});

test("a toggled investigation asks for the recording button on a bug report, an offer or Jev's judgment, and tells the composer", async (t) => {
  enabled(t);
  const investigated = async (
    route: Partial<{ bug: boolean; recording: boolean }>,
    question: string,
    write: () => Promise<void> = () => Promise.resolve()
  ) => {
    const { deps, run } = dependencies();
    deps.route = () =>
      Promise.resolve({ asksForHuman: 0, ...route, source: "jev" as const });
    deps.requestRecording = () =>
      write().then(() => {
        run.recording_requested = true;
      });
    const offered: boolean[] = [];
    const { gate } = deps;
    deps.gate = (...args) => {
      offered.push(args[7] === true);
      return gate(...args);
    };
    const body = (await (
      await receiveWidgetMessage(
        request({ ...investigate, message_id: crypto.randomUUID(), question }),
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
      )
    ).json()) as Record<string, unknown>;
    return [body.request_recording ?? false, offered[0]];
  };
  assert.deepEqual(
    await investigated({ bug: true }, "The save button does nothing."),
    [true, true]
  );
  // The pattern catches this one without any Jev score.
  assert.deepEqual(
    await investigated({}, "Can I send you a screen recording?"),
    [true, true]
  );
  // The pattern misses this typo; only Jev's judgment catches it.
  assert.deepEqual(
    await investigated(
      { recording: true },
      "i found a bug can i send a screen reco0rding"
    ),
    [true, true]
  );
  assert.deepEqual(
    await investigated({}, "Why did my campaign stop sending?"),
    [false, false]
  );
  // A failed write shows no button, so the reply must not point to one.
  assert.deepEqual(
    await investigated({ bug: true }, "The save button does nothing.", () =>
      Promise.reject(new Error("db"))
    ),
    [false, false]
  );
});

test("the investigation composer is told whether the recording button shows", async () => {
  const offered: boolean[] = [];
  for (const requested of [true, false]) {
    const { deps, run } = dependencies();
    deps.gate = (...args) => {
      offered.push(args[7] === true);
      return Promise.resolve(allowed);
    };
    // biome-ignore lint/performance/noAwaitInLoops: two independent runs, in order.
    await finishWidgetRun(
      { ...run, recording_requested: requested },
      "widget-session-recording",
      { findings: null, status: "completed", text: "The inbox disconnected." },
      deps
    );
  }
  assert.deepEqual(offered, [true, false]);
});

test("the guessed checks are saved as planned before the first real check runs", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  const saved: WidgetProgress[] = [];
  deps.plan = () => Promise.resolve(["inboxes", "campaigns"]);
  deps.progress = (_id, _session, progress) => {
    saved.push(progress);
    return Promise.resolve();
  };
  await receiveWidgetMessage(
    request(investigate),
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
  assert.deepEqual(saved[0], {
    checks: [
      { id: "inboxes", status: "planned" },
      { id: "campaigns", status: "planned" },
    ],
    sequence: 0,
    stage: "investigating",
  });
});

/** What the router returns when Jev fails after its retry. */
const jevDown = () =>
  Promise.resolve({
    asksForHuman: 0,
    failure: "reason=http_529 ms=3400",
    source: "fallback" as const,
  });

test("a message without the toggle is answered from the help center, whether Jev answered or is down", async (t) => {
  enabled(t);
  for (const route of [kbRoute, jevDown]) {
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

test("an owner or admin's help-center miss, refund or ticket request points to the magnifying glass, never an investigation", async (t) => {
  enabled(t);
  const refund = () =>
    Promise.resolve({ asksForHuman: 0, refund: true, source: "jev" as const });
  const ticket = () =>
    Promise.resolve({ asksForHuman: 0, source: "jev" as const, ticket: true });
  for (const [route, written] of [
    [kbRoute, "Tap the magnifying glass."],
    // Jev down: still the help center, and its miss still points to the toggle.
    [jevDown, "Tap the magnifying glass."],
    [refund, "Tap the magnifying glass."],
    [ticket, null],
  ] as const) {
    const { deps, gated, run } = dependencies();
    deps.route = route;
    let tried = false;
    deps.answerKb = () => {
      tried = true;
      return Promise.resolve(null);
    };
    const prompts: (string | undefined)[] = [];
    deps.answerChat = (_message, _log, system) => {
      prompts.push(system);
      return Promise.resolve(
        written ? { citations: [], message: written } : null
      );
    };
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({ ...start, message_id: crypto.randomUUID() }),
      noWork(),
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.message, written ?? INVESTIGATE_HINT_FALLBACK);
    assert.deepEqual(prompts, [INVESTIGATE_HINT_PROMPT]);
    // A refund or a ticket needs a look, so no article is tried for it.
    assert.equal(tried, route === kbRoute || route === jevDown);
    assert.equal(run.outcome?.reason, "kb_miss");
    assert.deepEqual(gated, []);
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
    return kbRoute();
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

const kbBase = {
  asksForHuman: 0,
  source: "jev" as const,
};
const cited = [
  { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
];

test("the previous reply's citations reach the fast lane, whatever the message", async (t) => {
  enabled(t);
  const history = [
    { role: "customer" as const, text: "how do i set up ai sdr?" },
    {
      citations: cited,
      role: "assistant" as const,
      text: "Connect a calendar.",
    },
  ];
  for (const asked of ["okay, what next?", "how do i buy a domain?"]) {
    const { deps } = dependencies();
    deps.route = kbRoute;
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
    assert.deepEqual(
      (got as { activeArticles: unknown }).activeArticles,
      cited
    );
  }
});

test("malformed citation history is dropped, not a reason to refuse the message", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  deps.route = kbRoute;
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
    deps.route = kbRoute;
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
      ...kbBase,
      chat: true,
    });
  const unclearRoute = () =>
    Promise.resolve({
      ...kbBase,
      unclear: 0.95,
    });
  for (const route of [kbRoute, chatRoute, unclearRoute]) {
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
    request(investigate),
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

test("internal-artifact blocks request a retry without disclosing the artifact", () => {
  for (const reason of [
    "internal_artifact:dpl_private",
    "composed:internal_artifact:dpl_private",
  ]) {
    const { run } = dependencies();
    run.outcome = {
      decision: "block",
      message: null,
      reason,
      status: "completed",
    };
    assert.deepEqual(widgetRunResponse(run), {
      decision: "block",
      findings: null,
      message: null,
      retry: true,
      run_id: runId,
      status: "completed",
    });
  }
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
    request(investigate),
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

test("cancel closes an open run and stops its session; a settled run is left alone", async (t) => {
  enabled(t);
  const cancel = (deps: WidgetDependencies, cancelled: string[]) =>
    receiveWidgetMessage(
      request({
        action: "cancel",
        conversation_id: scope.conversationId,
        organization_id: scope.organizationId,
        run_id: runId,
      }),
      {
        attachSession: (id) =>
          ({
            cancel: () => {
              cancelled.push(id);
              return Promise.resolve();
            },
          }) as unknown as Session,
        ...noWork(),
      },
      100,
      verify,
      deps
    );
  const open = dependencies();
  open.run.session_id = "widget-session-1";
  const stopped: string[] = [];
  const body = await (await cancel(open.deps, stopped)).json();
  assert.equal(body.status, "failed");
  assert.equal(open.run.outcome?.reason, "cancelled");
  assert.deepEqual(stopped, ["widget-session-1"]);

  const settled = dependencies();
  settled.run.session_id = "widget-session-1";
  settled.run.outcome = {
    decision: "allow",
    message: allowed.message,
    reason: allowed.reason,
    status: "completed",
  };
  settled.deps.cancel = () => assert.fail("a settled run is never cancelled");
  const untouched: string[] = [];
  await cancel(settled.deps, untouched);
  assert.deepEqual(untouched, []);
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
    request(investigate),
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

test("a filed refund ticket is the handoff to billing, so the customer gets a reply instead of a person", async () => {
  const { deps, gated, run } = dependencies();
  deps.extract = () => Promise.resolve({ ...findings, needsHuman: true });
  const url = "https://linear.app/acquisity/issue/ENG-15000/refund";
  const finish = (refund: boolean) =>
    finishWidgetRun(
      run,
      "widget-session-refund",
      {
        findings: null,
        status: "completed",
        text: "Refund request filed.",
        ticket: { id: "ENG-15000", url, ...(refund ? { refund } : {}) },
      },
      deps
    );
  await finish(true);
  await finish(false);
  const [refunded, other] = gated as WidgetFindings[];
  assert.equal(refunded?.needsHuman, false);
  // The findings contract carries only the ticket's id and url.
  assert.deepEqual(refunded?.ticket, { id: "ENG-15000", url });
  assert.equal(other?.needsHuman, true);
});

test("a ticket the model claims without a filed ticket result is dropped", async () => {
  const { deps, gated, run } = dependencies();
  deps.extract = () =>
    Promise.resolve({
      ...findings,
      ticket: {
        id: "ENG-15001",
        url: "https://linear.app/acquisity/issue/ENG-15001/made-up",
      },
    });
  await finishWidgetRun(
    run,
    "widget-session-claimed-ticket",
    {
      findings: null,
      status: "completed",
      text: "Filed ENG-15001.",
      ticket: null,
    },
    deps
  );
  const [claimed] = gated as WidgetFindings[];
  assert.equal(claimed?.ticket, undefined);
});

test("the ticket result carries whether Jev read it as a refund", async () => {
  const url = "https://linear.app/acquisity/issue/ENG-15000/refund";
  const outcome = await waitForWidgetInvestigation(
    session([
      event("action.result", {
        result: {
          callId: "call-1",
          kind: "tool-result",
          output: {
            existing: false,
            identifier: "ENG-15000",
            refund: true,
            url,
          },
          toolName: "widget_file_ticket",
        },
      }),
      event("session.completed"),
    ])
  );
  assert.deepEqual(outcome.status === "completed" && outcome.ticket, {
    id: "ENG-15000",
    refund: true,
    url,
  });
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
    request(investigate),
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
      asksForHuman: 0,
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

test("a screenshot sent before the customer has said anything gets a question back, even on a confident help-center route", async (t) => {
  enabled(t);
  const bare = {
    ...start,
    question: "(The customer sent only the screenshot below, with no message.)",
    screenshots: ["[Screenshot] Screen: AI SDR Inbox"],
  };
  for (const [history, reason] of [
    [undefined, "clarify"],
    // Only the greeting before it: the customer still has not asked anything.
    [
      [{ role: "assistant", text: "Hey! What can I help you with?" }],
      "clarify",
    ],
    // After their own question, the screenshot continues it.
    [[{ role: "customer", text: "can i buy more inboxes?" }], "kb"],
  ] as const) {
    const { deps, run } = dependencies();
    deps.route = kbRoute;
    deps.answerKb = () => Promise.resolve(kbAnswer);
    deps.answerChat = () =>
      Promise.resolve({
        citations: [],
        message: "I can see your AI SDR Inbox. What can I help you with there?",
      });
    // biome-ignore lint/performance/noAwaitInLoops: cases share nothing and are tiny.
    await receiveWidgetMessage(
      request({ ...bare, ...(history ? { history } : {}) }),
      noWork(),
      200,
      verify,
      deps
    );
    assert.equal(run.outcome?.reason, reason);
  }
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
    asksForHuman: 0.02,
    source: "jev" as const,
  };
  if (latest.startsWith("Now Google says")) {
    return {
      ...base,
      unclear: 0.46,
    };
  }
  if (latest === "and my dashboard totals") {
    return {
      ...base,
      unclear: 0.66,
    };
  }
  if (latest === "okay thanks") {
    return { ...base, chat: true };
  }
  return base;
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

// Unclear scores production logged on FRESH threads (2026-09-20, build
// fc818fd): both were investigated under lane routing.
const freshRoute = (unclear: number) => () =>
  Promise.resolve({
    asksForHuman: 0.04,
    source: "jev" as const,
    unclear,
  });

test("fresh thread: a documented how-to is answered from its article, and a bare fragment is asked what it means, neither touching the account", async (t) => {
  enabled(t);
  const google = {
    citations: [{ n: 1, title: "Google", url: docs(GOOGLE_BLOCKED) }],
    message: "Choose Advanced, then continue.",
  };
  for (const [asked, route, lane, reason, message] of [
    [
      "Now Google says the app is blocked when I connect Email and Calendar.",
      freshRoute(0.34),
      google,
      "kb",
      google.message,
    ],
    [
      "and my dashboard totals",
      freshRoute(0.71),
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
    assert.equal(got?.accountLikely, undefined);
    assert.equal(body.message, message);
    assert.equal(run.outcome?.reason, reason);
    assert.deepEqual(gated, []);
  }
});

test("an account question is investigated only with the toggle, and then with no help-center try", async (t) => {
  enabled(t);
  for (const toggled of [false, true]) {
    const { deps, gated } = dependencies();
    deps.route = freshRoute(0.57);
    let asked = false;
    deps.answerKb = () => {
      asked = true;
      return Promise.resolve(kbAnswer);
    };
    const { args, sends } = startedSessions();
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run.
    const response = await receiveWidgetMessage(
      request({
        ...(toggled ? investigate : start),
        message_id: crypto.randomUUID(),
        question: "why is my campaign not sending",
      }),
      args,
      200,
      verify,
      deps
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(asked, !toggled);
    assert.equal(sends.length, toggled ? 1 : 0);
    assert.equal(body.message, toggled ? allowed.message : kbAnswer.message);
    assert.deepEqual(gated, toggled ? [findings] : []);
  }
});

const explainRoute = (explainsPrevious: number) => () =>
  Promise.resolve({
    asksForAction: 0,
    asksForHuman: 0,
    asksOwnData: 0.9,
    confidence: 0.95,
    explainsPrevious,
    kbScore: 0,
    lane: "investigate" as const,
    source: "jev" as const,
  });
const generationHistory = [
  { role: "customer" as const, text: "any generation errors lately?" },
  {
    role: "assistant" as const,
    text: "No blocked decisions were recorded in the last 7 days. Live error monitoring could not be checked.",
  },
];
const startedSessions = () => {
  const sends: string[] = [];
  const args = {
    from: () =>
      ({
        send: (message: string) => {
          sends.push(message);
          return Promise.resolve(completedSession());
        },
      }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
    waitUntil: () => undefined,
  };
  return { args, sends };
};

// Live c2a648c: "Does that mean none happened, or just none were recorded?" took
// a 22s help-center miss and then a second generation investigation.
test("a question about what the previous reply meant is answered from that reply, with no help-center detour and no new investigation", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  deps.route = explainRoute(0.92);
  const prompts: (string | undefined)[] = [];
  let read = "";
  deps.answerChat = (message, _log, system) => {
    read = message;
    prompts.push(system);
    return Promise.resolve({
      citations: [],
      message:
        "Only that none were recorded; live errors could not be checked.",
    });
  };
  const response = await receiveWidgetMessage(
    request({
      ...start,
      history: generationHistory,
      question: "Does that mean none happened, or just none were recorded?",
    }),
    noWork(),
    200,
    verify,
    deps
  );
  const body = await response.json();
  assert.equal(body.message.startsWith("Only that none were recorded"), true);
  assert.equal(run.outcome?.reason, "explain");
  assert.equal(prompts.length, 1);
  // The writer is shown the whole previous reply, not a 400-character cut of it.
  assert.equal(
    read.includes("Live error monitoring could not be checked."),
    true
  );
});

test("a follow-up that wants fresh evidence, or that the writer cannot answer from the previous reply, goes on to the help center, not an investigation", async (t) => {
  enabled(t);
  for (const [score, reply] of [
    [0.3, "unused"],
    [0.92, null],
  ] as const) {
    const { deps, run } = dependencies();
    deps.route = explainRoute(score);
    deps.answerChat = () =>
      Promise.resolve(reply ? { citations: [], message: reply } : null);
    deps.answerKb = () => Promise.resolve(kbAnswer);
    const { args, sends } = startedSessions();
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh run, in order.
    await receiveWidgetMessage(
      request({
        ...start,
        history: generationHistory,
        message_id: `9999999${score === 0.3 ? 1 : 2}-9999-4999-8999-999999999999`,
        question: "can you check again for today?",
      }),
      args,
      200,
      verify,
      deps
    );
    assert.equal(sends.length, 0);
    assert.equal(run.outcome?.reason, "kb");
  }
});

test("with no previous reply in the supplied history there is nothing to explain, so the help center answers", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  deps.route = explainRoute(0.95);
  deps.answerChat = () => assert.fail("nothing to explain from");
  deps.answerKb = () => Promise.resolve(kbAnswer);
  const { args, sends } = startedSessions();
  await receiveWidgetMessage(
    request({ ...start, question: "what does that mean?" }),
    args,
    200,
    verify,
    deps
  );
  assert.equal(sends.length, 0);
  assert.equal(run.outcome?.reason, "kb");
});

// Run 02be7213: the explain writer timed out at 12s, the null was read as "needs
// a lookup", and a 135s investigation answered a question that needed none.
test("an explain writer that fails technically is retried once and then asks for a resend: never an investigation, never a handoff", async (t) => {
  enabled(t);
  const ask = (failures: number) => {
    const { deps, run } = dependencies();
    deps.route = explainRoute(0.92);
    let calls = 0;
    deps.answerChat = (_message, _log, _system, strict) => {
      calls += 1;
      assert.equal(strict, true);
      return calls <= failures
        ? Promise.reject(new DOMException("aborted", "TimeoutError"))
        : Promise.resolve({
            citations: [],
            message: "Only none were recorded.",
          });
    };
    return receiveWidgetMessage(
      request({
        ...start,
        history: generationHistory,
        message_id: `8888888${failures}-8888-4888-8888-888888888888`,
        question: "Does that mean none happened, or just none were recorded?",
      }),
      noWork(),
      200,
      verify,
      deps
    ).then(async (response) => ({
      body: await response.json(),
      calls: () => calls,
      run,
    }));
  };
  const recovered = await ask(1);
  assert.equal(recovered.calls(), 2);
  assert.equal(recovered.run.outcome?.reason, "explain");
  assert.equal(recovered.body.message, "Only none were recorded.");

  const down = await ask(2);
  assert.equal(down.calls(), 2);
  assert.equal(down.run.outcome?.reason, "explain_unavailable");
  // The app asks the customer to send it again instead of handing the thread over.
  assert.equal(down.body.retry, true);
  assert.equal(down.body.findings ?? null, null);
});

test("polls return persisted progress while answer preparation continues in the background", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  run.session_id = "widget-session-1";
  deps.progress = (_id, _session, progress) => {
    run.progress = progress;
    return Promise.resolve();
  };
  const { extract } = deps;
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.extract = async (...args) => {
    await paused;
    return extract(...args);
  };
  const background: Promise<unknown>[] = [];
  const response = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    {
      attachSession: () => completedSession(),
      from: noWork().from,
      waitUntil: (work) => {
        background.push(work);
      },
    },
    1,
    verify,
    deps
  );
  const body = await response.json();
  assert.equal(body.status, "pending");
  assert.equal(body.progress.stage, "preparing");
  assert.equal(background.length, 1);
  release?.();
  await Promise.all(background);
  assert.equal(run.outcome?.status, "completed");
});

test("result polls do not rewrite progress already saved by the background watcher", async (t) => {
  enabled(t);
  const { deps, run } = dependencies();
  run.session_id = "widget-session-1";
  run.progress = {
    checks: [{ id: "campaigns", status: "completed" }],
    sequence: 2,
    stage: "investigating",
  };
  let writes = 0;
  deps.progress = () => {
    writes += 1;
    return Promise.resolve();
  };
  const replay = session([
    event("actions.requested", {
      actions: [{ callId: "one", toolName: "widget_outreach_health" }],
      sequence: 0,
    }),
    event("action.result", {
      result: { callId: "one", kind: "tool-result", output: {} },
      sequence: 0,
    }),
  ]);
  const response = await receiveWidgetMessage(
    request({
      action: "result",
      conversation_id: scope.conversationId,
      organization_id: scope.organizationId,
      run_id: runId,
    }),
    {
      ...noWork(),
      attachSession: () => replay,
    },
    100,
    verify,
    deps
  );
  assert.equal((await response.json()).status, "pending");
  assert.equal(writes, 0);
});

test("one finish deadline, bounded by the app's last poll and the finish claim, reaches extraction and the gate", async () => {
  const deadlines = async (ageMs: number) => {
    const { deps, run } = dependencies();
    run.created_at = new Date(Date.now() - ageMs);
    const seen: (AbortSignal | undefined)[] = [];
    deps.extract = (input) => {
      seen.push(input.signal);
      return Promise.resolve(findings);
    };
    deps.gate = (...args) => {
      seen.push(args[6]);
      return Promise.resolve(allowed);
    };
    await finishWidgetRun(
      run,
      "widget-session-deadline",
      { findings: null, status: "completed", text: "The inbox disconnected." },
      deps
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    return seen;
  };
  // Past the app's last poll: the finish runs out at once and fails closed.
  const late = await deadlines(280_000);
  assert.equal(late.length, 2);
  assert.equal(late[0], late[1]);
  assert.equal(late[0]?.aborted, true);
  // A fresh run still has most of the finish claim to spend.
  const fresh = await deadlines(0);
  assert.equal(fresh[0]?.aborted, false);
});

test("the finish budget is counted from the claim, history read included, and leaves the completion write inside the lease and the last poll", async () => {
  const LEASE_MS = 150_000;
  const POLL_WINDOW_MS = 285_000;
  const SAVE_MS = 15_000;
  const budget = async (claimAgeMs: number) => {
    const { deps, run } = dependencies();
    const createdAt = 1_000_000;
    run.created_at = new Date(createdAt);
    let now = createdAt + claimAgeMs;
    let granted: { at: number; ms: number } | undefined;
    deps.history = () => {
      now += 14_000;
      return Promise.resolve([]);
    };
    await finishWidgetRun(
      run,
      "widget-session-budget",
      { findings: null, status: "completed", text: "The inbox disconnected." },
      deps,
      {
        now: () => now,
        timeout: (ms) => {
          granted = { at: now, ms };
          return new AbortController().signal;
        },
      }
    );
    assert.ok(granted);
    // The model work may run to the deadline; the completion write then takes
    // up to its own database deadline.
    const savedAt = granted.at + granted.ms + SAVE_MS;
    const claimedAt = createdAt + claimAgeMs;
    assert.ok(savedAt - claimedAt <= LEASE_MS, `lease ${savedAt - claimedAt}`);
    assert.ok(
      savedAt - createdAt <= POLL_WINDOW_MS,
      `poll ${savedAt - createdAt}`
    );
    return granted.ms;
  };
  // An early claim: 14s of history comes out of the 150s lease.
  assert.equal(await budget(0), 119_000);
  // A late claim at run age 169s: the app's last poll is the limit.
  assert.equal(await budget(169_000), 85_000);
});

test("a recording the customer sent skips the front door and binds its id to the investigation", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  deps.route = () => assert.fail("must not route a recording follow-up");
  let auth: { attributes?: Record<string, unknown> } | undefined;
  const response = await receiveWidgetMessage(
    request({
      ...start,
      question: "(The customer sent the screen recording you asked for.)",
      recording: { id: "0f3c9d6e-1b2a-4c5d-8e9f-a0b1c2d3e4f5" },
    }),
    {
      from: () => ({
        send: (_message: string, { auth: sent }: { auth: typeof auth }) => {
          auth = sent;
          return Promise.resolve(completedSession());
        },
      }),
      waitUntil: () => undefined,
    } as unknown as Pick<RouteHandlerArgs, "from" | "waitUntil">,
    200,
    verify,
    deps
  );
  assert.equal(response.status, 200);
  assert.equal(
    auth?.attributes?.recordingId,
    "0f3c9d6e-1b2a-4c5d-8e9f-a0b1c2d3e4f5"
  );
});

test("a member's recording still takes the help-center front door, and a malformed recording id is refused", async (t) => {
  enabled(t);
  const { deps } = dependencies();
  let routed = false;
  const { route } = deps;
  deps.route = (...args) => {
    routed = true;
    return route(...args);
  };
  await receiveWidgetMessage(
    request({ ...start, recording: { id: "jam-1" } }),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "member" as const }),
    deps
  );
  assert.equal(routed, true);
  const refused = await receiveWidgetMessage(
    request({ ...start, recording: { id: "../jams" } }),
    noWork(),
    1,
    () => assert.fail("must not verify"),
    deps
  );
  assert.equal(refused.status, 400);
});

test("an owner or admin who turns on Investigate my workspace skips the front door and starts an investigation", async (t) => {
  enabled(t);
  const investigated = async (role: "owner" | "admin") => {
    const { deps } = dependencies();
    // Jev is asked only whether to offer a recording; no help-center reply is written.
    deps.answerKb = () => assert.fail("must not try the help center");
    deps.answerChat = () => assert.fail("must not write a front-door reply");
    let sent = false;
    const response = await receiveWidgetMessage(
      request({ ...start, mode: "investigate" }),
      {
        from: () => ({
          send: () => {
            sent = true;
            return Promise.resolve(completedSession());
          },
        }),
        waitUntil: () => undefined,
      } as unknown as Pick<RouteHandlerArgs, "from" | "waitUntil">,
      200,
      () => Promise.resolve({ ...scope, role }),
      deps
    );
    return response.status === 200 && sent;
  };
  assert.deepEqual(
    await Promise.all([investigated("owner"), investigated("admin")]),
    [true, true]
  );
});

test("Investigate my workspace from a member, or an owner the live database no longer backs, gets a help-center answer, and an unknown mode is refused", async (t) => {
  enabled(t);
  const member = dependencies();
  let routed = false;
  const { route } = member.deps;
  member.deps.route = (...args) => {
    routed = true;
    return route(...args);
  };
  member.deps.answerKb = () => Promise.resolve(kbAnswer);
  const memberResponse = await receiveWidgetMessage(
    request({ ...start, mode: "investigate" }),
    noWork(),
    200,
    () => Promise.resolve({ ...scope, role: "member" as const }),
    member.deps
  );
  assert.equal(routed, true);
  assert.equal(
    ((await memberResponse.json()) as Record<string, unknown>).message,
    kbAnswer.message
  );

  const denied = dependencies();
  denied.deps.verifyAccess = () => Promise.reject(new WorkspaceAccessDenied());
  const asks: WidgetAsk[] = [];
  denied.deps.answerKb = (ask) => {
    asks.push(ask as WidgetAsk);
    return Promise.resolve(kbAnswer);
  };
  const deniedResponse = await receiveWidgetMessage(
    request({ ...start, mode: "investigate" }),
    noWork(),
    200,
    verify,
    denied.deps
  );
  assert.equal(deniedResponse.status, 200);
  assert.equal(
    ((await deniedResponse.json()) as Record<string, unknown>).message,
    kbAnswer.message
  );
  assert.equal(asks.at(-1)?.cannotLook, true);
  const refused = await receiveWidgetMessage(
    request({ ...start, mode: "kb" }),
    noWork(),
    1,
    () => assert.fail("must not verify"),
    denied.deps
  );
  assert.equal(refused.status, 400);
});
