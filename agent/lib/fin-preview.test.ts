import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  receiveFinProbe,
  waitForDiagnostic,
  waitForProbe,
} from "./fin-preview.js";
import type { FinProbeResult } from "./fin-preview-slack.js";

type EventStream = Awaited<ReturnType<Session["getEventStream"]>>;
type StreamEvent =
  EventStream extends ReadableStream<infer Event> ? Event : never;
type PreviewEnv =
  | "FIN_FOREMAN_PREVIEW_ENABLED"
  | "FIN_FOREMAN_PREVIEW_SLACK_CHANNEL"
  | "FIN_FOREMAN_PREVIEW_TOKEN"
  | "VERCEL_ENV";

const enablePreview = (
  context: TestContext,
  overrides: Partial<Record<PreviewEnv, string | undefined>> = {}
) => {
  const values: Record<PreviewEnv, string | undefined> = {
    FIN_FOREMAN_PREVIEW_ENABLED: "true",
    FIN_FOREMAN_PREVIEW_SLACK_CHANNEL: undefined,
    FIN_FOREMAN_PREVIEW_TOKEN: "test-only-token",
    VERCEL_ENV: "preview",
    ...overrides,
  };
  for (const name of Object.keys(values) as PreviewEnv[]) {
    const previous = process.env[name];
    context.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
    if (values[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = values[name];
    }
  }
};

// The fixtures omit lifecycle metadata that the probe never reads.
const completed = (message: string, finishReason = "stop") =>
  ({
    data: { finishReason, message },
    type: "message.completed",
  }) as StreamEvent;

const sessionWithEvents = (events: StreamEvent[]): Session =>
  ({
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream<StreamEvent>({
          start(controller) {
            for (const event of events) {
              controller.enqueue(event);
            }
            controller.close();
          },
        })
      ),
    id: "test-session",
  }) as Session;

const request = (body: string, authorization = "Bearer test-only-token") =>
  new Request("https://preview.example.test/internal/fin-probe", {
    body,
    headers: { authorization, "content-type": "application/json" },
    method: "POST",
  });

describe("Fin preview intake", () => {
  for (const [name, environment] of [
    ["production", { VERCEL_ENV: "production" }],
    ["a missing preview switch", { FIN_FOREMAN_PREVIEW_ENABLED: undefined }],
    ["a disabled preview switch", { FIN_FOREMAN_PREVIEW_ENABLED: "false" }],
    ["a missing token", { FIN_FOREMAN_PREVIEW_TOKEN: undefined }],
  ] as const) {
    it(`never invokes Foreman in ${name}`, async (context) => {
      enablePreview(context, environment);
      const response = await receiveFinProbe(request("{}"), {
        attachSession: () =>
          assert.fail("disabled intake must not read a session"),
        from: () => assert.fail("disabled intake must not create a session"),
        waitUntil: () => assert.fail("disabled intake must not notify Slack"),
      });
      assert.equal(response.status, 404);
    });
  }

  it("rejects missing, incorrect, and differently sized bearer values before dispatch", async (context) => {
    enablePreview(context);
    await Promise.all(
      ["", "Bearer wrong", "x".repeat(1000)].map(async (authorization) => {
        const response = await receiveFinProbe(request("{}", authorization), {
          attachSession: () =>
            assert.fail("unauthorized intake must not read a session"),
          from: () =>
            assert.fail("unauthorized intake must not create a session"),
          waitUntil: () =>
            assert.fail("unauthorized intake must not notify Slack"),
        });
        assert.equal(response.status, 401);
      })
    );
  });

  it("keeps empty requests as the fixed probe with the service identity", async (context) => {
    enablePreview(context);
    await Promise.all(
      ["", "{}", JSON.stringify({ handle: "", question: "" })].map(
        async (body) => {
          const incoming = request(body);
          let fromCalls = 0;
          let sendCalls = 0;
          let probe = "";
          const response = await receiveFinProbe(incoming, {
            attachSession: () =>
              assert.fail("a connection probe creates its own session"),
            from(address) {
              fromCalls += 1;
              assert.equal(typeof address, "string");
              probe = String(address);
              return {
                send(message, options) {
                  sendCalls += 1;
                  assert.equal(
                    message,
                    `This is an internal Fin connection test. Do not use tools, consult memory, or investigate anything. Reply with exactly FOREMAN_CONNECTED:${probe}`
                  );
                  assert.deepEqual(options, {
                    auth: {
                      attributes: {},
                      authenticator: "bearer",
                      issuer: "foreman:fin-preview",
                      principalId: "fin-preview",
                      principalType: "service",
                    },
                    mode: "task",
                  });
                  return Promise.resolve(
                    sessionWithEvents([completed(`FOREMAN_CONNECTED:${probe}`)])
                  );
                },
              } as ReturnType<RouteHandlerArgs["from"]>;
            },
            waitUntil: () => undefined,
          });
          assert.equal(fromCalls, 1);
          assert.equal(sendCalls, 1);
          assert.equal(incoming.bodyUsed, true);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.deepEqual(await response.json(), {
            message:
              "Foreman received this connection test and replied successfully.",
            probe,
            session_id: "test-session",
            status: "connected",
          });
        }
      )
    );
  });

  it("does not expose an unexpected agent reply or report it as connected", async (context) => {
    enablePreview(context);
    const response = await receiveFinProbe(request("{}"), {
      attachSession: () =>
        assert.fail("a connection probe creates its own session"),
      from: () =>
        ({
          send: () =>
            Promise.resolve(
              sessionWithEvents([completed("unexpected private agent output")])
            ),
        }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
      waitUntil: () => undefined,
    });
    const result = await response.json();
    assert.equal(result.status, "unexpected_reply");
    assert.equal(
      result.message,
      "Foreman replied, but did not return the expected connection-test response."
    );
    assert.ok(
      !JSON.stringify(result).includes("unexpected private agent output")
    );
  });
});

describe("Fin probe stream", () => {
  it("waits past tool-call messages for the exact matching final response", async () => {
    const session = sessionWithEvents([
      completed("intermediate message", "tool-calls"),
      completed("  FOREMAN_CONNECTED:probe-1\n"),
    ]);
    assert.equal(await waitForProbe(session, "probe-1"), "connected");
  });

  it("does not accept another probe's successful reply", async () => {
    const session = sessionWithEvents([completed("FOREMAN_CONNECTED:probe-2")]);
    assert.equal(await waitForProbe(session, "probe-1"), "unexpected_reply");
  });

  for (const type of ["turn.failed", "session.failed"] as const) {
    it(`reports ${type} without treating it as a successful probe`, async () => {
      const session = sessionWithEvents([{ data: {}, type } as StreamEvent]);
      assert.equal(await waitForProbe(session, "probe-1"), "failed");
    });
  }

  it("reports an ended stream without a final reply as pending", async () => {
    assert.equal(
      await waitForProbe(sessionWithEvents([]), "probe-1"),
      "pending"
    );
  });

  it("ends a stalled stream at the deadline and cancels its reader", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<StreamEvent>({
      cancel() {
        cancellations += 1;
      },
    });
    const session: Pick<Session, "getEventStream"> = {
      getEventStream: () => Promise.resolve(stream),
    };
    assert.equal(await waitForProbe(session, "probe-1", 5), "pending");
    assert.equal(cancellations, 1);
  });
});

const terminal = (
  type:
    | "session.completed"
    | "session.failed"
    | "turn.started"
    | "turn.completed"
) => ({ data: {}, type }) as StreamEvent;

describe("Fin diagnostic intake", () => {
  it("rejects malformed, oversized, and caller-selected authority before starting work", async (context) => {
    enablePreview(context);
    await Promise.all(
      [
        "not JSON",
        JSON.stringify({ action: "unknown", question: "Check credits" }),
        JSON.stringify({ question: "x".repeat(4001) }),
        JSON.stringify({ callback_url: 123, question: "Check credits" }),
        JSON.stringify({
          callback_url: "https://attacker.test/report",
          question: "Check credits",
        }),
        JSON.stringify({
          callback_url: "x".repeat(2049),
          question: "Check credits",
        }),
        JSON.stringify({
          question: "Check credits",
          workspace_id: "another-workspace",
        }),
        JSON.stringify({
          auth: { principalId: "another-user" },
          question: "Check credits",
        }),
      ].map(async (body) => {
        const response = await receiveFinProbe(request(body), {
          attachSession: () => assert.fail("invalid input must not read work"),
          from: () => assert.fail("invalid input must not start work"),
          waitUntil: () => assert.fail("invalid input must not notify Slack"),
        });
        assert.equal(response.status, 400);
      })
    );
  });

  it("rejects explicit starts or result checks missing their required input without creating a probe", async (context) => {
    enablePreview(context);
    await Promise.all(
      [
        { action: "start", handle: "", question: "" },
        { action: "start", handle: "stale-saved-handle", question: "  " },
        { action: "result", handle: "", question: "" },
        { action: "result", handle: "  ", question: "Check credits" },
      ].map(async (input) => {
        const response = await receiveFinProbe(request(JSON.stringify(input)), {
          attachSession: () =>
            assert.fail("missing input must not read another session"),
          from: () =>
            assert.fail("missing input must not start any run or probe"),
          waitUntil: () => assert.fail("missing input must not post to Slack"),
        });
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.equal(result.status, "failed");
        assert.ok(
          result.message.includes("no run was started") ||
            result.message.includes("no new run was started")
        );
      })
    );
  });

  it("investigates the bounded question and replays only its signed session without a new run or Slack post", async (context) => {
    enablePreview(context);
    const tasks: Promise<unknown>[] = [];
    let starts = 0;
    const answer =
      "The test workspace has 42 credits. Source: the verified workspace billing record.";
    const events = [
      completed("Checking the workspace", "tool-calls"),
      completed(answer),
      terminal("session.completed"),
    ];
    const response = await receiveFinProbe(
      request(
        JSON.stringify({
          action: "start",
          handle: "stale-saved-handle",
          question: "Check my credits",
        })
      ),
      {
        attachSession: () =>
          assert.fail("starting does not attach existing sessions"),
        from: () =>
          ({
            send(message, options) {
              starts += 1;
              assert.equal(typeof message, "string");
              assert.ok(String(message).includes("Read-only:"));
              assert.ok(
                String(message).includes("aaron-fragas-workspace-wMUMT")
              );
              assert.ok(String(message).includes("aaron.fraga@acquisity.ai"));
              assert.ok(
                String(message).endsWith("Question:\nCheck my credits")
              );
              assert.equal(options.mode, "task");
              assert.deepEqual(options.auth?.attributes, {});
              return Promise.resolve(sessionWithEvents(events));
            },
          }) as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: (task) => tasks.push(task),
      }
    );
    const first = await response.json();
    assert.equal(response.status, 200);
    assert.equal(first.status, "completed");
    assert.equal(first.message, answer);
    assert.equal(first.session_id, "test-session");
    assert.equal(typeof first.run_handle, "string");
    assert.equal(starts, 1);
    await Promise.all(tasks);

    const resultContext: Parameters<typeof receiveFinProbe>[1] = {
      attachSession(id) {
        assert.equal(id, "test-session");
        return sessionWithEvents(events);
      },
      from: () => assert.fail("result reads never start an agent"),
      waitUntil: () =>
        assert.fail("result reads never create Slack notifications"),
    };
    const read = await receiveFinProbe(
      request(
        JSON.stringify({
          action: "result",
          handle: first.run_handle,
          question: "Do not start another run",
        })
      ),
      resultContext
    );
    assert.deepEqual(await read.json(), first);

    const [payload, signature] = first.run_handle.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.session_id = "unrelated-slack-session";
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
    await Promise.all(
      ["test-session", tampered, `${payload}.invalid-signature`].map(
        async (handle) => {
          const rejected = await receiveFinProbe(
            request(JSON.stringify({ handle, question: "" })),
            {
              ...resultContext,
              attachSession: () =>
                assert.fail(
                  "unsigned or altered handles must not read any session"
                ),
            }
          );
          assert.equal(rejected.status, 403);
        }
      )
    );
  });

  it("returns pending without cancelling its one background observer, which later receives the actual answer", async (context) => {
    enablePreview(context);
    const tasks: Promise<unknown>[] = [];
    let controller: ReadableStreamDefaultController<StreamEvent> | undefined;
    let reads = 0;
    let cancelled = 0;
    const stream = new ReadableStream<StreamEvent>({
      cancel() {
        cancelled += 1;
      },
      start(value) {
        controller = value;
      },
    });
    const session = {
      getEventStream() {
        reads += 1;
        return Promise.resolve(stream);
      },
      id: "slow-test-session",
    } as Session;
    const response = await receiveFinProbe(
      request(JSON.stringify({ question: "Check the test workspace" })),
      {
        attachSession: () =>
          assert.fail("starting does not attach an existing session"),
        from: () =>
          ({ send: () => Promise.resolve(session) }) as unknown as ReturnType<
            RouteHandlerArgs["from"]
          >,
        waitUntil: (task) => tasks.push(task),
      },
      5
    );
    const first = await response.json();
    assert.equal(first.status, "pending");
    assert.equal(first.session_id, "slow-test-session");
    assert.ok(first.run_handle);
    assert.equal(reads, 1);
    assert.equal(cancelled, 0);
    assert.equal(tasks.length, 1);
    assert.ok(controller);
    controller.enqueue(completed("Workspace read completed successfully."));
    controller.enqueue(terminal("session.completed"));
    const [observed] = (await tasks[0]) as [FinProbeResult, unknown];
    assert.equal(observed.status, "completed");
    assert.equal(observed.message, "Workspace read completed successfully.");
    assert.equal(reads, 1);
    assert.equal(cancelled, 1);
  });

  it("seeds the callback only in durable channel state and preserves signed result reads", async (context) => {
    enablePreview(context);
    const callbackUrl = `https://api.intercom.io/hooks/procedures/callback/${"a".repeat(488)}`;
    const tasks: Promise<unknown>[] = [];
    const events = [
      completed("Verified report."),
      terminal("session.completed"),
    ];
    let probe = "";
    const response = await receiveFinProbe(
      request(
        JSON.stringify({
          action: "start",
          callback_url: callbackUrl,
          question: "Check credits",
        })
      ),
      {
        attachSession: () => assert.fail("start must create its own session"),
        from(address) {
          probe = address;
          return {
            send(message, options) {
              assert.ok(!String(message).includes(callbackUrl));
              assert.deepEqual(options.state, {
                callback: {
                  answer: "",
                  delivered: false,
                  url: callbackUrl,
                },
              });
              return Promise.resolve(sessionWithEvents(events));
            },
          } as ReturnType<Parameters<typeof receiveFinProbe>[1]["from"]>;
        },
        waitUntil: (task) => tasks.push(task),
      }
    );
    const accepted = await response.json();
    assert.equal(response.status, 200);
    assert.equal(accepted.status, "pending");
    assert.equal(accepted.session_id, "test-session");
    assert.equal(accepted.probe, probe);
    assert.ok(accepted.run_handle);
    assert.ok(!JSON.stringify(accepted).includes(callbackUrl));
    await Promise.all(tasks);
    const read = await receiveFinProbe(
      request(
        JSON.stringify({
          action: "result",
          callback_url: "",
          handle: accepted.run_handle,
        })
      ),
      {
        attachSession: () => sessionWithEvents(events),
        from: () => assert.fail("result check must not start another run"),
        waitUntil: () => assert.fail("result check must not notify Slack"),
      }
    );
    assert.equal((await read.json()).message, "Verified report.");
  });

  it("rejects callbacks that do not accompany a fresh diagnostic start", async (context) => {
    enablePreview(context);
    const callbackUrl = `https://api.intercom.io/hooks/procedures/callback/${"a".repeat(488)}`;
    await Promise.all(
      [
        { callback_url: callbackUrl },
        {
          action: "result",
          callback_url: callbackUrl,
          handle: "saved-handle",
          question: "Check credits",
        },
        {
          callback_url: callbackUrl,
          handle: "saved-handle",
          question: "Check credits",
        },
      ].map(async (input) => {
        const response = await receiveFinProbe(request(JSON.stringify(input)), {
          attachSession: () =>
            assert.fail("a callback cannot retarget an existing run"),
          from: () =>
            assert.fail("invalid callback input cannot create a probe"),
          waitUntil: () =>
            assert.fail("invalid callback input cannot send messages"),
        });
        assert.equal(response.status, 400);
      })
    );
  });

  it("does not return a raw dispatch exception or invent a run handle", async (context) => {
    enablePreview(context);
    const tasks: Promise<unknown>[] = [];
    const response = await receiveFinProbe(
      request(JSON.stringify({ question: "Check the test workspace" })),
      {
        attachSession: () =>
          assert.fail("a rejected start must not read another session"),
        from: () =>
          ({
            send: () =>
              Promise.reject(new Error("private provider credential")),
          }) as unknown as ReturnType<RouteHandlerArgs["from"]>,
        waitUntil: (task) => tasks.push(task),
      }
    );
    const result = await response.json();
    assert.equal(result.status, "failed");
    assert.equal(result.session_id, "");
    assert.equal(result.run_handle, "");
    assert.ok(!JSON.stringify(result).includes("private provider credential"));
    await Promise.all(tasks);
  });
});

describe("Fin diagnostic stream", () => {
  it("waits through interim replies and later delegated turns until the whole task completes", async () => {
    const result = await waitForDiagnostic(
      sessionWithEvents([
        completed("I delegated the check."),
        terminal("turn.completed"),
        terminal("turn.started"),
        completed("The source returned 42 credits.", "tool-calls"),
        completed("Verified final answer: 42 credits."),
        terminal("session.completed"),
      ])
    );
    assert.deepEqual(result, {
      message: "Verified final answer: 42 credits.",
      status: "completed",
    });
  });

  it("does not turn an interim reply or an empty final turn into a completed answer", async () => {
    const incomplete = await waitForDiagnostic(
      sessionWithEvents([
        completed("I am checking."),
        terminal("turn.completed"),
      ])
    );
    assert.equal(incomplete.status, "pending");
    const empty = await waitForDiagnostic(
      sessionWithEvents([
        completed("I am checking."),
        terminal("turn.started"),
        terminal("session.completed"),
      ])
    );
    assert.equal(empty.status, "failed");
  });

  it("returns a fixed failure for a failed task or stream exception", async () => {
    const failedRun = await waitForDiagnostic(
      sessionWithEvents([
        completed("Partial answer"),
        terminal("session.failed"),
      ])
    );
    assert.equal(failedRun.status, "failed");
    const failedStream = await waitForDiagnostic({
      getEventStream: () =>
        Promise.resolve(
          new ReadableStream<StreamEvent>({
            start(controller) {
              controller.error(new Error("private exception"));
            },
          })
        ),
    });
    assert.equal(failedStream.status, "failed");
    assert.ok(!JSON.stringify(failedStream).includes("private exception"));
  });

  it("cancels a stalled observer at its own deadline and bounds long reports", async () => {
    let cancelled = 0;
    const result = await waitForDiagnostic(
      {
        getEventStream: () =>
          Promise.resolve(
            new ReadableStream<StreamEvent>({
              cancel() {
                cancelled += 1;
              },
            })
          ),
      },
      5
    );
    assert.equal(result.status, "pending");
    assert.equal(cancelled, 1);
    const long = await waitForDiagnostic(
      sessionWithEvents([
        completed("x".repeat(13_000)),
        terminal("session.completed"),
      ])
    );
    assert.equal(long.status, "completed");
    assert.equal(long.message, `${"x".repeat(12_000)}\n[Report truncated.]`);
  });
});
