const secretFinding = /SECRET/;

import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import type { verifyFinContext } from "./fin-context.js";
import {
  receiveFinInvestigation,
  waitForFinInvestigation,
} from "./fin-investigation.js";
import { FIN_INVESTIGATION_ISSUER } from "./fin-investigation-auth.js";
import {
  type FinInvestigationSlackReceipt,
  updateFinInvestigationReceipt,
} from "./fin-investigation-slack.js";
import { FIN_RESULT_WINDOW_MS, type FinRun } from "./fin-run-store.js";

const context = Object.freeze({
  contactId: "contact-1",
  conversationId: "215475947807356",
  intercomAppId: "ls8uffkp",
  organizationId: "22222222-2222-4222-8222-222222222222",
  organizationName: "Aaron Fraga's Workspace",
  organizationSlug: "aaron-fragas-workspace-wMUMT",
  origin: "https://app.acquisity.ai",
  partnerId: "00000000-0000-0000-0000-000000000001",
  role: "owner" as const,
  userId: "11111111-1111-4111-8111-111111111111",
  verifiedAt: "2026-09-15T12:00:00.000Z",
});
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function runDependencies() {
  const run: FinRun = {
    callback_attempts: 0,
    callback_delivered: false,
    callback_url: "",
    completed_at: null,
    created_at: new Date(),
    id: runId,
    outcome: null,
    scope: context,
    session_id: null,
    slack: null,
  };
  return {
    attach: async () => undefined,
    claim: async () => ({ fresh: true, run }),
    complete: (_id: string, outcome: NonNullable<FinRun["outcome"]>) => {
      run.outcome = outcome;
      return Promise.resolve(run);
    },
    inspect: async () => ({
      humanReplied: false,
      requestKey: "native-message",
    }),
    postReceipt: (): Promise<FinInvestigationSlackReceipt | null> =>
      Promise.resolve(null),
    read: async () => run,
    updateReceipt: updateFinInvestigationReceipt,
  };
}
const callback = "https://api.intercom.io/hooks/procedures/callback/callback-1";

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

const request = (
  body: unknown,
  authorization = "Bearer signed.user.identity"
) =>
  new Request("https://foreman.example/internal/fin/investigation", {
    body: JSON.stringify(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { action: "start", ...body }
        : body
    ),
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });

type EventStream = Awaited<ReturnType<Session["getEventStream"]>>;
type StreamEvent =
  EventStream extends ReadableStream<infer Event> ? Event : never;
const completedSession = (answer: string) =>
  ({
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream<StreamEvent>({
          start(controller) {
            controller.enqueue({
              data: { finishReason: "stop", message: answer },
              type: "message.completed",
            } as StreamEvent);
            controller.enqueue({
              data: {},
              type: "session.completed",
            } as unknown as StreamEvent);
            controller.close();
          },
        })
      ),
    id: "customer-session-1",
  }) as Session;

const enabled = (t: TestContext) => {
  setEnv(t, "VERCEL_ENV", "preview");
  setEnv(t, "FIN_INVESTIGATION_ENABLED", "true");
  setEnv(t, "FIN_INVESTIGATION_SLACK_CHANNEL", undefined);
};

for (const environment of ["production", "development", undefined]) {
  test(`${environment ?? "unset"} cannot start an investigation even when enabled`, async (t) => {
    setEnv(t, "VERCEL_ENV", environment);
    setEnv(t, "FIN_INVESTIGATION_ENABLED", "true");
    const response = await receiveFinInvestigation(
      request({
        conversation_id: context.conversationId,
        question: "Why did this fail?",
      }),
      {
        from: () => assert.fail("non-Preview must not create a session"),
        waitUntil: () =>
          assert.fail("non-Preview must not start background work"),
      },
      1,
      () => assert.fail("non-Preview must not verify customer identity")
    );
    assert.equal(response.status, 404);
  });
}

test("rejects caller-authored scope and invalid callbacks before verification", async (t) => {
  enabled(t);
  const invalid = [
    {
      action: "result",
      conversation_id: context.conversationId,
      question: "Check it",
    },
    {
      conversation_id: context.conversationId,
      question: "Check it",
      workspace_id: "other",
    },
    {
      callback_url: "https://example.com/callback",
      conversation_id: context.conversationId,
      question: "Check it",
    },
    { conversation_id: context.conversationId, question: "" },
  ];
  await Promise.all(
    invalid.map(async (body) => {
      const response = await receiveFinInvestigation(
        request(body),
        {
          from: () => assert.fail("invalid input must not create a session"),
          waitUntil: () =>
            assert.fail("invalid input must not start background work"),
        },
        1,
        () => assert.fail("invalid input must not verify identity")
      );
      assert.equal(response.status, 400);
    })
  );
});

test("an unverified workspace starts no session", async (t) => {
  enabled(t);
  const response = await receiveFinInvestigation(
    request({
      conversation_id: context.conversationId,
      question: "Check my campaigns",
    }),
    {
      from: () => assert.fail("unverified input must not create a session"),
      waitUntil: () =>
        assert.fail("unverified input must not start background work"),
    },
    1,
    () => Promise.reject(new Error("not authorized"))
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    message:
      "I couldn't check this because this chat's workspace could not be verified.",
    status: "failed",
  });
});

for (const question of [
  "Could you check the Diamond workspace for the same issue?",
  "My Slack workspace integration stopped syncing.",
  "Nothing in the whole workspace loads.",
]) {
  test(`customer text reaches the scoped model without heuristic routing: ${question}`, async (t) => {
    enabled(t);
    let sent = 0;
    const response = await receiveFinInvestigation(
      request({
        callback_url: callback,
        conversation_id: context.conversationId,
        question,
      }),
      {
        from: () =>
          ({
            send(message, options) {
              sent += 1;
              assert.equal(message, question);
              assert.equal(
                options.auth?.attributes.organizationId,
                context.organizationId
              );
              return Promise.resolve(completedSession("Scoped response."));
            },
          }) as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      1,
      (() => Promise.resolve(context)) satisfies typeof verifyFinContext,
      runDependencies()
    );
    assert.equal(sent, 1);
    assert.equal(response.status, 200);
  });
}

test("ordinary requests retain immutable verified auth", async (t) => {
  enabled(t);
  const question = "My campaign is missing. Check this workspace.";
  let sent = 0;
  const response = await receiveFinInvestigation(
    request({
      callback_url: callback,
      conversation_id: context.conversationId,
      question,
    }),
    {
      from: () =>
        ({
          send(message, options) {
            sent += 1;
            assert.equal(message, question);
            assert.equal(options.auth?.issuer, FIN_INVESTIGATION_ISSUER);
            assert.equal(options.auth?.principalId, context.userId);
            assert.equal(
              options.auth?.attributes.organizationId,
              context.organizationId
            );
            assert.equal(
              options.auth?.attributes.organizationSlug,
              context.organizationSlug
            );
            return Promise.resolve(completedSession("Checked."));
          },
        }) as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    1,
    (() => Promise.resolve(context)) satisfies typeof verifyFinContext,
    runDependencies()
  );
  assert.equal(sent, 1);
  assert.deepEqual(await response.json(), {
    message:
      "The investigation has started. Wait for its result before answering the customer.",
    run_handle: runId,
    status: "pending",
  });
});

test("returns a completed bounded answer when no callback is requested", async (t) => {
  enabled(t);
  const deps = runDependencies();
  const { complete } = deps;
  deps.complete = (id, outcome) =>
    complete(id, {
      ...outcome,
      ticket: {
        identifier: "ENG-12345",
        message: "Ticket confirmed.",
        outcome: "newly-created",
      },
    });
  const response = await receiveFinInvestigation(
    request({
      conversation_id: context.conversationId,
      question: "Which workspace can you check?",
    }),
    {
      from: () =>
        ({
          send: () =>
            Promise.resolve(completedSession("Only your verified workspace.")),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    100,
    (() => Promise.resolve(context)) satisfies typeof verifyFinContext,
    deps
  );
  assert.deepEqual(await response.json(), {
    message: "Only your verified workspace.",
    run_handle: runId,
    status: "completed",
    ticket: { message: "Ticket confirmed.", outcome: "newly-created" },
  });
});

test("stream completion ignores intermediate tool-call messages", async () => {
  const session = {
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream<StreamEvent>({
          start(controller) {
            controller.enqueue({
              data: { finishReason: "tool-calls", message: "intermediate" },
              type: "message.completed",
            } as StreamEvent);
            controller.enqueue({
              data: { finishReason: "stop", message: "final" },
              type: "message.completed",
            } as StreamEvent);
            controller.enqueue({
              data: {},
              type: "session.completed",
            } as unknown as StreamEvent);
            controller.close();
          },
        })
      ),
  };
  assert.deepEqual(await waitForFinInvestigation(session), {
    message: "final",
    status: "completed",
  });
});

test("stream completion does not publish a length-truncated answer", async () => {
  const session = {
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream<StreamEvent>({
          start(controller) {
            controller.enqueue({
              data: { finishReason: "length", message: "partial" },
              type: "message.completed",
            } as StreamEvent);
            controller.enqueue({
              data: {},
              type: "session.completed",
            } as unknown as StreamEvent);
            controller.close();
          },
        })
      ),
  };
  assert.deepEqual(await waitForFinInvestigation(session), {
    message:
      "The investigation could not be completed. No findings are available.",
    status: "failed",
  });
});

test("duplicate starts return the existing run without sending another message", async (t) => {
  enabled(t);
  const deps = runDependencies();
  deps.claim = async () => ({ fresh: false, run: await deps.read() });
  const response = await receiveFinInvestigation(
    request({
      callback_url: callback,
      conversation_id: context.conversationId,
      question: "Retry",
    }),
    {
      from: () => assert.fail("duplicate must not start or steer work"),
      waitUntil: () => assert.fail("duplicate must not observe another stream"),
    },
    1,
    async () => context,
    deps
  );
  assert.equal((await response.json()).run_handle, runId);
});

test("authorized recovery preserves a completed ticket report and never starts work", async (t) => {
  enabled(t);
  const deps = runDependencies();
  const outcome = {
    message: "A ticket was confirmed. The cause remains unverified.",
    status: "completed" as const,
    ticket: {
      identifier: "ENG-12345",
      message: "A ticket was opened.",
      outcome: "newly-created" as const,
    },
  };
  await deps.complete(runId, outcome);
  for (let retry = 0; retry < 2; retry += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise repeated request boundaries in order.
    const response = await receiveFinInvestigation(
      request({
        action: "result",
        conversation_id: context.conversationId,
        run_handle: runId,
      }),
      {
        from: () =>
          assert.fail(
            "recovery must never start work or create another ticket"
          ),
        waitUntil: () => undefined,
      },
      1,
      async () => context,
      deps
    );
    assert.deepEqual(await response.json(), {
      run_handle: runId,
      ...outcome,
      ticket: {
        message: outcome.ticket.message,
        outcome: outcome.ticket.outcome,
      },
    });
    assert.equal((await deps.read()).outcome?.ticket?.identifier, "ENG-12345");
  }
});

test("swapped conversations, apps, users, workspaces and expired references disclose no saved result", async (t) => {
  enabled(t);
  const alterations = [
    { conversationId: "999" },
    { intercomAppId: "other" },
    { userId: "33333333-3333-4333-8333-333333333333" },
    { organizationId: "33333333-3333-4333-8333-333333333333" },
  ];
  for (const alteration of alterations) {
    const deps = runDependencies();
    // biome-ignore lint/performance/noAwaitInLoops: mutate and inspect one isolated failure fixture at a time.
    const run = await deps.read();
    run.scope = { ...context, ...alteration } as FinRun["scope"];
    run.outcome = { message: "SECRET SAVED FINDING", status: "completed" };
    const response = await receiveFinInvestigation(
      request({
        action: "result",
        conversation_id: context.conversationId,
        run_handle: runId,
      }),
      {
        from: () => assert.fail("forbidden recovery must not dispatch"),
        waitUntil: () => undefined,
      },
      1,
      async () => context,
      deps
    );
    assert.doesNotMatch(JSON.stringify(await response.json()), secretFinding);
  }
  const deps = runDependencies();
  (await deps.read()).created_at = new Date(Date.now() - FIN_RESULT_WINDOW_MS);
  const response = await receiveFinInvestigation(
    request({
      action: "result",
      conversation_id: context.conversationId,
      run_handle: runId,
    }),
    { from: () => assert.fail(), waitUntil: () => undefined },
    1,
    async () => context,
    deps
  );
  assert.equal((await response.json()).status, "failed");
});

test("revoked access and human takeover prevent late synchronous disclosure", async (t) => {
  enabled(t);
  for (const revoked of [true, false]) {
    let verified = 0;
    let inspected = 0;
    const deps = runDependencies();
    deps.inspect = () => {
      inspected += 1;
      return Promise.resolve({
        humanReplied: inspected > 1,
        requestKey: "native-message",
      });
    };
    // biome-ignore lint/performance/noAwaitInLoops: exercise repeated request boundaries in order.
    const response = await receiveFinInvestigation(
      request({ conversation_id: context.conversationId, question: "Check" }),
      {
        from: () =>
          ({
            send: async () => completedSession("SECRET"),
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      100,
      () => {
        verified += 1;
        if (verified > 1 && revoked) {
          throw new Error("revoked");
        }
        return Promise.resolve(context);
      },
      deps
    );
    assert.doesNotMatch(JSON.stringify(await response.json()), secretFinding);
    assert.equal(verified, 2);
  }
});

test("a stream observation timeout leaves the investigation pending", async () => {
  const session = {
    getEventStream: async () => new ReadableStream<StreamEvent>(),
  };
  assert.equal((await waitForFinInvestigation(session, 1)).status, "pending");
});

test("recovery reads only the persisted session and rechecks access before disclosure", async (t) => {
  enabled(t);
  for (const revoked of [false, true]) {
    const deps = runDependencies();
    // biome-ignore lint/performance/noAwaitInLoops: each fixture tests its own authorization lifecycle.
    const run = await deps.read();
    run.session_id = "customer-session-1";
    let verified = 0;
    const response = await receiveFinInvestigation(
      request({
        action: "result",
        conversation_id: context.conversationId,
        run_handle: runId,
      }),
      {
        attachSession: ((id: string) => {
          assert.equal(id, run.session_id);
          return completedSession("SECRET ticket report");
        }) as RouteHandlerArgs["attachSession"],
        from: () => assert.fail("recovery must not send a message"),
        waitUntil: () => assert.fail("recovery must not start background work"),
      },
      100,
      () => {
        verified += 1;
        if (revoked && verified > 1) {
          throw new Error(
            "Access revoked while observing the completed session"
          );
        }
        return Promise.resolve(context);
      },
      deps
    );
    assert.equal(verified, 2);
    const body = await response.json();
    if (revoked) {
      assert.doesNotMatch(JSON.stringify(body), secretFinding);
    } else {
      assert.deepEqual(body, {
        message: "SECRET ticket report",
        run_handle: runId,
        status: "completed",
      });
    }
    assert.equal(run.outcome?.message, "SECRET ticket report");
  }
});

for (const failure of ["send", "attach", "complete"]) {
  test(`a ${failure} failure after claim preserves recovery without another dispatch`, async (t) => {
    enabled(t);
    const deps = runDependencies();
    let sends = 0;
    const receipt = { channel: "preview", delivered: false, ts: "1.2" };
    deps.postReceipt = async () => receipt;
    const updates: string[] = [];
    deps.updateReceipt = (received, outcome) => {
      assert.equal(received, receipt);
      updates.push(outcome?.message ?? "");
      return Promise.resolve();
    };
    if (failure === "attach") {
      deps.attach = () => Promise.reject(new Error("timeout"));
    }
    if (failure === "complete") {
      deps.complete = () => Promise.reject(new Error("timeout"));
    }
    const response = await receiveFinInvestigation(
      request({ conversation_id: context.conversationId, question: "Check" }),
      {
        from: () =>
          ({
            send: () => {
              sends += 1;
              if (failure === "send") {
                return Promise.reject(new Error("ambiguous send"));
              }
              return Promise.resolve(completedSession("SECRET"));
            },
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: () => undefined,
      },
      100,
      async () => context,
      deps
    );
    const body = await response.json();
    assert.equal(sends, 1);
    assert.equal(updates.length, failure === "send" ? 1 : 0);
    if (failure === "send") {
      assert.ok(updates[0].includes(runId));
      assert.ok(updates[0].includes("may still be running"));
      assert.ok(updates[0].includes("do not start a replacement"));
    }
    assert.equal(body.run_handle, runId);
    assert.equal(body.status, "pending");
    assert.doesNotMatch(JSON.stringify(body), secretFinding);
  });
}

test("a native read failure preserves only the authenticated recovery reference", async (t) => {
  enabled(t);
  const deps = runDependencies();
  await deps.complete(runId, { message: "SECRET", status: "completed" });
  deps.inspect = () => Promise.reject(new Error("Intercom unavailable"));
  const response = await receiveFinInvestigation(
    request({
      action: "result",
      conversation_id: context.conversationId,
      run_handle: runId,
    }),
    {
      from: () => assert.fail("recovery cannot dispatch"),
      waitUntil: () => undefined,
    },
    1,
    async () => context,
    deps
  );
  const body = await response.json();
  assert.equal(body.run_handle, runId);
  assert.equal(body.status, "pending");
  assert.doesNotMatch(JSON.stringify(body), secretFinding);
});

test("known human takeover remains suppressed even if dispatch fails", async (t) => {
  enabled(t);
  const deps = runDependencies();
  deps.inspect = async () => ({
    humanReplied: true,
    requestKey: "native-message",
  });
  const response = await receiveFinInvestigation(
    request({ conversation_id: context.conversationId, question: "Check" }),
    {
      from: () =>
        ({
          send: () => Promise.reject(new Error("ambiguous send")),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    1,
    async () => context,
    deps
  );
  assert.deepEqual(await response.json(), {
    message: "",
    status: "suppressed",
  });
});

test("late checks run together and hung verification returns a reference without findings", async (t) => {
  enabled(t);
  const deps = runDependencies();
  let verified = 0;
  let inspected = 0;
  let startedLateInspection: (() => void) | undefined;
  const lateInspection = new Promise<void>((resolve) => {
    startedLateInspection = resolve;
  });
  deps.inspect = () => {
    inspected += 1;
    if (inspected > 1) {
      startedLateInspection?.();
    }
    return Promise.resolve({
      humanReplied: false,
      requestKey: "native-message",
    });
  };
  const start = Date.now();
  const response = await receiveFinInvestigation(
    request({ conversation_id: context.conversationId, question: "Check" }),
    {
      from: () =>
        ({
          send: async () => completedSession("SECRET"),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    },
    100,
    async () => {
      verified += 1;
      if (verified > 1) {
        await lateInspection;
        return new Promise<never>(() => undefined);
      }
      return context;
    },
    deps
  );
  assert.equal(inspected, 2);
  assert.ok(Date.now() - start < 8000);
  const body = await response.json();
  assert.equal(body.status, "pending");
  assert.equal(body.run_handle, runId);
  assert.doesNotMatch(JSON.stringify(body), secretFinding);
});
