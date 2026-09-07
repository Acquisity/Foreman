import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
  readInstantlySubworkspace,
} from "./instantly-api.js";

const ADMIN_ID = "24f5c554-bf6c-4f51-a909-d25d9617cff9";
const MEMBER_ID = "019e050a-b40f-7d29-ba21-67bfd9d99788";
const WORKSPACE_ID = "e05cbe7b-67db-4b07-b712-46b9365dc83f";
const SECOND_WORKSPACE_ID = "019e050a-b40f-7d29-ba21-67c1bc8062b2";
const MAX_TEST_RESPONSE_BYTES = 256 * 1024;
const AMBIGUOUS_WORKSPACE = /More than one accepted Instantly subworkspace/u;
const NO_ACCEPTED_WORKSPACE = /No accepted Instantly subworkspace/u;
const REPEATED_CURSOR = /repeated a Workspace Group pagination cursor/u;
const TOO_MANY_GROUP_PAGES = /too many Workspace Group pages/u;
const WRONG_ADMIN_WORKSPACE = /configured IBG admin workspace/u;
const INSTANTLY_TIMEOUT = /^Instantly did not respond within 15 seconds\.$/u;
const INSTANTLY_UNREACHABLE = /^Instantly could not be reached\.$/u;

const member = (
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
  admin_workspace_id: ADMIN_ID,
  admin_workspace_name: "IBG",
  id: MEMBER_ID,
  status: "accepted",
  sub_workspace_id: WORKSPACE_ID,
  sub_workspace_name: "Rick Livingston's Workspace",
  ...overrides,
});

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
      status,
    })
  );

const cancelableError = (
  status: number,
  onCancel: () => void,
  headers: Record<string, string> = {}
): Promise<Response> =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        cancel: onCancel,
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"detail":"private provider detail"}')
          );
        },
      }),
      { headers, status }
    )
  );

const uuidFor = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

describe("Instantly Workspace Group", () => {
  it("follows every page and returns accepted subworkspaces with admin provenance", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return String(url).includes("starting_after=next-page")
        ? json({
            items: [
              member({
                id: "019e050a-ef7d-7986-ae6a-d1b767704534",
                status: "pending",
                sub_workspace_id: "019e050a-ef7d-7986-ae6a-d1b767704535",
                sub_workspace_name: "Pending Workspace",
              }),
              member({
                id: "019e050a-ef7d-7986-ae6a-d1b767704536",
                sub_workspace_id: SECOND_WORKSPACE_ID,
                sub_workspace_name: "Second Workspace",
              }),
            ],
          })
        : json({ items: [member()], next_starting_after: "next-page" });
    };

    const result = await listInstantlySubworkspaces({
      fetch: fetchStub,
    });

    assert.deepEqual(result, {
      adminWorkspace: { id: ADMIN_ID, name: "IBG" },
      excludedMemberships: { pending: 1, rejected: 0 },
      membershipComplete: true,
      nextStartingAfter: null,
      subworkspaces: [
        { id: SECOND_WORKSPACE_ID, name: "Second Workspace" },
        { id: WORKSPACE_ID, name: "Rick Livingston's Workspace" },
      ],
      totalAcceptedSubworkspaces: 2,
      totalMatches: 2,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url.endsWith("?limit=100"), true);
    assert.equal(
      calls[1]?.url.endsWith("?limit=100&starting_after=next-page"),
      true
    );
    for (const { init } of calls) {
      assert.equal(init?.method, "GET");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), null);
      assert.equal(headers.has("x-as-workspace"), false);
    }
  });

  it("does not expose provider error bodies", async () => {
    let canceled = 0;
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () =>
          cancelableError(401, () => {
            canceled += 1;
          }),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.status, 401);
        assert.equal(error.kind, "authorization");
        assert.equal(error.message.includes("private provider detail"), false);
        return true;
      }
    );
    assert.equal(canceled, 1);
  });

  it("rejects a credential for a different admin workspace", async () => {
    let calls = 0;
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () => {
          calls += 1;
          return json({
            items: [
              member({
                admin_workspace_id: "fba27324-a0fb-4630-8986-80b4ff1f879a",
              }),
            ],
          });
        },
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "authorization");
        assert.match(error.message, WRONG_ADMIN_WORKSPACE);
        return true;
      }
    );
    assert.equal(calls, 1);
  });

  it("retries a short rate limit and respects the retry hint", async () => {
    let calls = 0;
    let canceled = 0;
    const delays: number[] = [];
    const result = await listInstantlySubworkspaces({
      fetch: () => {
        calls += 1;
        return calls === 1
          ? cancelableError(
              429,
              () => {
                canceled += 1;
              },
              { "Retry-After": "1" }
            )
          : json({ items: [member()] });
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    assert.equal(calls, 2);
    assert.equal(canceled, 1);
    assert.deepEqual(delays, [1000]);
    assert.equal(result.subworkspaces.length, 1);
  });

  it("returns a safe error instead of sleeping through a long rate limit", async () => {
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () => json({}, 429, { "Retry-After": "60" }),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "rate-limited");
        assert.equal(error.retryAfterSeconds, 60);
        return true;
      }
    );
  });

  it("retries transient network failures with bounded backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await listInstantlySubworkspaces({
      fetch: () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(new TypeError("temporary network failure"))
          : json({ items: [member()] });
      },
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
    assert.equal(result.subworkspaces.length, 1);
  });

  it("rejects a repeated cursor instead of looping", async () => {
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () =>
          json({ items: [member()], next_starting_after: "same-cursor" }),
      }),
      REPEATED_CURSOR
    );
  });

  it("fails closed when the Workspace Group exceeds 100 pages", async () => {
    let calls = 0;
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () => {
          calls += 1;
          return json({
            items: [
              member({
                id: uuidFor(calls),
                sub_workspace_id: uuidFor(calls + 1000),
              }),
            ],
            next_starting_after: `cursor-${calls}`,
          });
        },
      }),
      TOO_MANY_GROUP_PAGES
    );
    assert.equal(calls, 100);
  });

  it("rejects an oversized streamed provider response", async () => {
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () =>
          Promise.resolve(
            new Response("x".repeat(MAX_TEST_RESPONSE_BYTES + 1))
          ),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "too-much-data");
        return true;
      }
    );
  });

  it("cancels a response whose declared length exceeds the limit", async () => {
    let canceled = 0;
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () =>
          cancelableError(
            200,
            () => {
              canceled += 1;
            },
            { "Content-Length": String(MAX_TEST_RESPONSE_BYTES + 1) }
          ),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "too-much-data");
        return true;
      }
    );
    assert.equal(canceled, 1);
  });
});

describe("Instantly subworkspace reads", () => {
  it("rejects invalid direct-call limits before contacting Instantly", async () => {
    await Promise.all(
      [0, 101, Number.NaN, 1.5].map(async (limit) => {
        let calls = 0;
        await assert.rejects(
          readInstantlySubworkspace(
            { id: WORKSPACE_ID },
            "campaigns",
            { limit },
            {
              fetch: () => {
                calls += 1;
                return json({ items: [member()] });
              },
            }
          ),
          (error) => {
            assert.ok(error instanceof InstantlyApiError);
            assert.equal(error.kind, "invalid-input");
            return true;
          }
        );
        assert.equal(calls, 0);
      })
    );
  });

  it("finds an authoritative ID beyond page one and propagates the resource cursor", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      const calledUrl = String(url);
      if (calledUrl.includes("starting_after=group-page-two")) {
        return json({ items: [member()] });
      }
      if (calledUrl.includes("workspace-group-members")) {
        return json({
          items: [
            member({
              id: "019e050a-ef7d-7986-ae6a-d1b767704536",
              sub_workspace_id: SECOND_WORKSPACE_ID,
              sub_workspace_name: "First-page Workspace",
            }),
          ],
          next_starting_after: "group-page-two",
        });
      }
      return json({
        items: [
          {
            id: "campaign-1",
            name: "Campaign",
            provider_credentials: { password: "private" },
            smtp_password: "private",
          },
        ],
        next_starting_after: "next-resource",
      });
    };

    const result = await readInstantlySubworkspace(
      { id: WORKSPACE_ID },
      "campaigns",
      { limit: 50, search: "Renewals", startingAfter: "campaign-cursor" },
      { fetch: fetchStub }
    );

    assert.deepEqual(result, {
      items: [{ id: "campaign-1", name: "Campaign" }],
      nextStartingAfter: "next-resource",
      resource: "campaigns",
      workspace: { id: WORKSPACE_ID, name: "Rick Livingston's Workspace" },
    });
    assert.equal(calls.length, 3);
    assert.equal(
      calls[2]?.url.endsWith(
        "/campaigns?limit=50&starting_after=campaign-cursor&search=Renewals"
      ),
      true
    );
    const headers = new Headers(calls[2]?.init?.headers);
    assert.equal(headers.get("Authorization"), null);
    assert.equal(headers.get("x-as-workspace"), WORKSPACE_ID);
  });

  it("normalizes an exact workspace name and rejects ambiguous matches", async () => {
    const result = await readInstantlySubworkspace(
      { name: "  RICK   LIVINGSTON'S workspace " },
      "accounts",
      {},
      {
        fetch: (url) =>
          String(url).includes("workspace-group-members")
            ? json({ items: [member()] })
            : json({ items: [] }),
      }
    );
    assert.equal(result.workspace.id, WORKSPACE_ID);

    await assert.rejects(
      readInstantlySubworkspace(
        { name: "Duplicate" },
        "accounts",
        {},
        {
          fetch: () =>
            json({
              items: [
                member({ sub_workspace_name: "Duplicate" }),
                member({
                  id: "019e050a-ef7d-7986-ae6a-d1b767704536",
                  sub_workspace_id: SECOND_WORKSPACE_ID,
                  sub_workspace_name: " duplicate ",
                }),
              ],
            }),
        }
      ),
      AMBIGUOUS_WORKSPACE
    );
  });

  it("does not read a pending or rejected workspace", async () => {
    await Promise.all(
      (["pending", "rejected"] as const).map(async (status) => {
        let calls = 0;
        await assert.rejects(
          readInstantlySubworkspace(
            { id: WORKSPACE_ID },
            "accounts",
            {},
            {
              fetch: () => {
                calls += 1;
                return json({ items: [member({ status })] });
              },
            }
          ),
          NO_ACCEPTED_WORKSPACE
        );
        assert.equal(calls, 1);
      })
    );
  });

  it("allowlists account fields instead of returning provider credentials", async () => {
    const result = await readInstantlySubworkspace(
      { id: WORKSPACE_ID },
      "accounts",
      {},
      {
        fetch: (url) =>
          String(url).includes("workspace-group-members")
            ? json({ items: [member()] })
            : json({
                items: [
                  {
                    email: "sender@example.com",
                    provider_code: 2,
                    provider_credentials: { password: "private" },
                    smtp_password: "private",
                    status: 1,
                  },
                ],
              }),
      }
    );

    assert.deepEqual(result.items, [
      { email: "sender@example.com", provider_code: 2, status: 1 },
    ]);
  });

  it("rejects a sanitized resource page that exceeds the output budget", async () => {
    const preview = "x".repeat(MAX_TEST_RESPONSE_BYTES - 150);
    await assert.rejects(
      readInstantlySubworkspace(
        { id: WORKSPACE_ID },
        "emails",
        {},
        {
          fetch: (url) =>
            String(url).includes("workspace-group-members")
              ? json({ items: [member()] })
              : json({ items: [{ content_preview: preview, id: "email-1" }] }),
        }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "too-much-data");
        return true;
      }
    );
  });

  it("forces email previews and strips bodies, attachments, and addresses", async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchStub: typeof fetch = (url, init) => {
      calls.push({ init, url: String(url) });
      return String(url).includes("workspace-group-members")
        ? json({ items: [member()] })
        : json({
            items: [
              {
                attachment_json: { files: [{ url: "https://private" }] },
                bcc_address_email_list: "bcc@example.com",
                bcc_address_json: [{ address: "bcc@example.com" }],
                body: { html: "<p>private</p>", text: "private" },
                cc_address_email_list: "cc@example.com",
                cc_address_json: [{ address: "cc@example.com" }],
                content_preview: "A bounded preview",
                from_address_email: "sender@example.com",
                from_address_json: [{ address: "sender@example.com" }],
                id: "email-1",
                reply_to: "reply@example.com",
                subject: "Question",
                to_address_email_list: "recipient@example.com",
                to_address_json: [{ address: "recipient@example.com" }],
              },
            ],
          });
    };

    const result = await readInstantlySubworkspace(
      { id: WORKSPACE_ID },
      "emails",
      {
        emailType: "received",
        latestOfThread: true,
        lead: "lead@example.com",
      },
      { fetch: fetchStub }
    );

    assert.deepEqual(result.items, [
      {
        content_preview: "A bounded preview",
        id: "email-1",
        subject: "Question",
      },
    ]);
    assert.equal(
      calls[1]?.url.endsWith(
        "/emails?limit=20&preview_only=true&email_type=received&latest_of_thread=true&lead=lead%40example.com"
      ),
      true
    );
  });
});

describe("Instantly request deadlines", () => {
  /** Rejects only when the signal it was handed aborts, with that signal's reason. */
  const signalDrivenFetch =
    (started?: () => void): typeof fetch =>
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        started?.();
      });

  /** Runs `body` with the deadline timer under the test's control. */
  const withDeadlineTimer = async (
    body: (expire: () => void) => Promise<void>
  ): Promise<void> => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await body(() => mock.timers.tick(15_000));
    } finally {
      mock.timers.reset();
    }
  };

  /** Starts a read whose fetch hangs until the composed signal aborts. */
  const startRead = (read: (fetchImpl: typeof fetch) => Promise<unknown>) => {
    let ready: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    return { pending: read(signalDrivenFetch(() => ready())), started };
  };

  /** Lets every pending job run, so a hung read is a failure, not a stall. */
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 20; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each tick must drain before the next.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  };

  const isCancellation = (error: unknown): boolean =>
    error instanceof Error &&
    !(error instanceof InstantlyApiError) &&
    error.name === "AbortError";

  const isTimeout = (error: unknown): boolean => {
    assert.ok(error instanceof InstantlyApiError);
    assert.equal(error.kind, "inaccessible");
    assert.match(error.message, INSTANTLY_TIMEOUT);
    return true;
  };

  it("gives every paginated request its own deadline composed with the caller signal", async () => {
    const controller = new AbortController();
    const sent: AbortSignal[] = [];
    let calls = 0;
    const fetchStub: typeof fetch = (_url, init) => {
      sent.push(init?.signal as AbortSignal);
      calls += 1;
      return calls === 1
        ? json({ items: [member()], next_starting_after: "cursor-1" })
        : json({ items: [member({ sub_workspace_id: SECOND_WORKSPACE_ID })] });
    };

    const result = await listInstantlySubworkspaces({
      fetch: fetchStub,
      signal: controller.signal,
    });

    // Pagination is unchanged: both cursors walked, both pages kept.
    assert.equal(calls, 2);
    assert.equal(result.subworkspaces.length, 2);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0], sent[1]);
    for (const signal of sent) {
      assert.notEqual(signal, controller.signal);
      assert.equal(signal.aborted, false);
    }

    controller.abort();
    for (const signal of sent) {
      assert.equal(signal.aborted, true);
    }
  });

  it("attaches the deadline when the caller passes no signal", async () => {
    let sent: AbortSignal | null | undefined;
    const fetchStub: typeof fetch = (_url, init) => {
      sent = init?.signal;
      return json({ items: [member()] });
    };

    await listInstantlySubworkspaces({ fetch: fetchStub });

    assert.ok(sent instanceof AbortSignal);
    assert.equal(sent.aborted, false);
  });

  it("maps an expired deadline to the Instantly timeout message", async () => {
    await withDeadlineTimer(async (expire) => {
      const { pending, started } = startRead((fetchImpl) =>
        listInstantlySubworkspaces({ fetch: fetchImpl })
      );
      await started;

      expire();

      await assert.rejects(pending, isTimeout);
    });
  });

  it("does not retry a request that hit its deadline", async () => {
    await withDeadlineTimer(async (expire) => {
      let calls = 0;
      let ready: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const countingFetch: typeof fetch = (url, init) => {
        calls += 1;
        return signalDrivenFetch(() => ready())(url, init);
      };
      const pending = listInstantlySubworkspaces({
        fetch: countingFetch,
        sleep: () => Promise.resolve(),
      });
      await started;

      expire();

      await assert.rejects(pending, isTimeout);
      assert.equal(calls, 1);
    });
  });

  it("keeps an expired deadline a timeout when the caller aborts afterwards", async () => {
    await withDeadlineTimer(async (expire) => {
      const controller = new AbortController();
      const { pending, started } = startRead((fetchImpl) =>
        listInstantlySubworkspaces({
          fetch: fetchImpl,
          signal: controller.signal,
        })
      );
      await started;

      // The deadline fires first, then the caller aborts before the rejection
      // handler runs. The request still timed out.
      expire();
      controller.abort();

      await assert.rejects(pending, isTimeout);
    });
  });

  it("reports a caller abort that beats the deadline as cancellation", async () => {
    await withDeadlineTimer(async (expire) => {
      const controller = new AbortController();
      const { pending, started } = startRead((fetchImpl) =>
        listInstantlySubworkspaces({
          fetch: fetchImpl,
          signal: controller.signal,
        })
      );
      await started;

      controller.abort();
      expire();

      await assert.rejects(pending, isCancellation);
    });
  });

  it("reports an already-aborted caller signal as cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      readInstantlySubworkspace(
        { id: WORKSPACE_ID },
        "accounts",
        {},
        { fetch: signalDrivenFetch(), signal: controller.signal }
      ),
      isCancellation
    );
  });

  it("bounds a retryable response whose body cancellation never settles", async () => {
    await withDeadlineTimer(async (expire) => {
      let calls = 0;
      let cancelling: () => void = () => undefined;
      const discarding = new Promise<void>((resolve) => {
        cancelling = resolve;
      });
      const fetchStub: typeof fetch = () => {
        calls += 1;
        if (calls > 1) {
          return json({ items: [member()] });
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelling();
                // A cancellation that never settles, as a stalled body gives.
                return new Promise<void>(() => undefined);
              },
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
              },
            }),
            { status: 503 }
          )
        );
      };

      const pending = listInstantlySubworkspaces({
        fetch: fetchStub,
        sleep: () => Promise.resolve(),
      });
      await discarding;

      // The attempt's own deadline still covers disposing the response, so the
      // stalled cancellation gives way instead of hanging, and the request
      // that ran out of its own time is reported rather than retried.
      expire();

      const outcome = await Promise.race([
        pending.then(
          () => "resolved" as const,
          (error: unknown) => error
        ),
        flush().then(() => "hung" as const),
      ]);

      assert.notEqual(outcome, "hung");
      assert.equal(isTimeout(outcome), true);
      assert.equal(calls, 1);
    });
  });

  it("bounds a non-retryable response whose body cancellation never settles", async () => {
    await withDeadlineTimer(async (expire) => {
      let cancelling: () => void = () => undefined;
      const discarding = new Promise<void>((resolve) => {
        cancelling = resolve;
      });
      const fetchStub: typeof fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelling();
                return new Promise<void>(() => undefined);
              },
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
              },
            }),
            { status: 400 }
          )
        );

      const pending = listInstantlySubworkspaces({
        fetch: fetchStub,
      });
      await discarding;

      expire();

      await assert.rejects(pending, isTimeout);
    });
  });

  it("bounds oversized response disposal when body cancellation never settles", async () => {
    await withDeadlineTimer(async (expire) => {
      let cancelling: () => void = () => undefined;
      const discarding = new Promise<void>((resolve) => {
        cancelling = resolve;
      });
      const fetchStub: typeof fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelling();
                return new Promise<void>(() => undefined);
              },
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
            }),
            { headers: { "content-length": String(256 * 1024 + 1) } }
          )
        );

      const pending = listInstantlySubworkspaces({
        fetch: fetchStub,
      });
      await discarding;

      expire();

      await assert.rejects(pending, isTimeout);
    });
  });

  it("bounds a response body read that never settles", async () => {
    await withDeadlineTimer(async (expire) => {
      let pulling: () => void = () => undefined;
      const reading = new Promise<void>((resolve) => {
        pulling = resolve;
      });
      let cancelling: () => void = () => undefined;
      const cancelled = new Promise<void>((resolve) => {
        cancelling = resolve;
      });
      const fetchStub: typeof fetch = () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancelling();
              },
              pull: () => {
                pulling();
                return new Promise<void>(() => undefined);
              },
            })
          )
        );

      const pending = listInstantlySubworkspaces({
        fetch: fetchStub,
      });
      await reading;

      expire();

      await assert.rejects(pending, isTimeout);
      await cancelled;
    });
  });

  it("propagates a caller abort during disposal as cancellation", async () => {
    let calls = 0;
    let cancelling: () => void = () => undefined;
    const discarding = new Promise<void>((resolve) => {
      cancelling = resolve;
    });
    const controller = new AbortController();
    const fetchStub: typeof fetch = () => {
      calls += 1;
      if (calls > 1) {
        return json({ items: [member()] });
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelling();
              // A cancellation that never settles, as a stalled body gives.
              return new Promise<void>(() => undefined);
            },
            start(controller_) {
              controller_.enqueue(new TextEncoder().encode("{}"));
            },
          }),
          // Over the retry wait cap, so the retryable status would otherwise
          // surface as a rate-limit error rather than the caller's abort.
          { headers: { "retry-after": "6" }, status: 429 }
        )
      );
    };

    const pending = listInstantlySubworkspaces({
      fetch: fetchStub,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    });
    await discarding;

    controller.abort();

    await assert.rejects(pending, isCancellation);
    assert.equal(calls, 1);
  });

  it("does not report an unrelated TimeoutError as a deadline expiry", async () => {
    let calls = 0;
    const timeoutNamedFetch: typeof fetch = () => {
      calls += 1;
      return Promise.reject(
        new DOMException("Upstream timed out.", "TimeoutError")
      );
    };

    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: timeoutNamedFetch,
        sleep: () => Promise.resolve(),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "inaccessible");
        assert.match(error.message, INSTANTLY_UNREACHABLE);
        return true;
      }
    );
    assert.equal(calls, 3);
  });
});

describe("Instantly large membership sets", () => {
  it("validates every membership page for a selected resource while preserving the list output cap", async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = (address, init) => {
      const url = new URL(String(address));
      calls.push(url.pathname + url.search);
      if (url.pathname.endsWith("/workspace-group-members")) {
        const second = url.searchParams.has("starting_after");
        return json({
          items: Array.from({ length: 100 }, (_, index) =>
            member({
              id: uuidFor(index + (second ? 100 : 0) + 1),
              sub_workspace_id: uuidFor(index + (second ? 100 : 0) + 1),
              sub_workspace_name: "x".repeat(1400),
            })
          ),
          next_starting_after: second ? null : "second-page",
        });
      }
      assert.equal(
        new Headers(init?.headers).get("x-as-workspace"),
        uuidFor(1)
      );
      return json({
        items: [
          { id: "campaign-1", name: "Preview", smtp_password: "private" },
        ],
      });
    };
    const page = await listInstantlySubworkspaces({ fetch: fetchStub });
    assert.equal(calls.length, 2);
    assert.equal(page.membershipComplete, true);
    assert.equal(page.totalAcceptedSubworkspaces, 200);
    assert.equal(page.totalMatches, 200);
    assert.equal(page.subworkspaces.length, 20);
    assert.equal(page.nextStartingAfter, uuidFor(20));
    assert.ok(
      Buffer.byteLength(JSON.stringify(page)) <= MAX_TEST_RESPONSE_BYTES
    );
    calls.length = 0;
    const result = await readInstantlySubworkspace(
      { id: uuidFor(1) },
      "campaigns",
      { limit: 1 },
      { fetch: fetchStub }
    );
    assert.equal(calls.length, 3);
    assert.ok(calls[1]?.includes("starting_after=second-page"));
    assert.equal(result.workspace.id, uuidFor(1));
    assert.deepEqual(result.items, [{ id: "campaign-1", name: "Preview" }]);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) < MAX_TEST_RESPONSE_BYTES
    );
  });
});

describe("Instantly workspace discovery", () => {
  it("searches all pages by a normalized literal fragment and returns every ambiguous candidate", async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = (address) => {
      const url = String(address);
      calls.push(url);
      return url.includes("starting_after")
        ? json({
            items: [
              member({
                sub_workspace_id: uuidFor(2),
                sub_workspace_name: "New [ACME]  Team",
              }),
              member({
                sub_workspace_id: uuidFor(3),
                sub_workspace_name: "New [acme] Team",
              }),
              member({
                status: "pending",
                sub_workspace_name: "New [acme] Team",
              }),
              member({
                status: "rejected",
                sub_workspace_name: "New [acme] Team",
              }),
            ],
          })
        : json({ items: [member()], next_starting_after: "page-two" });
    };
    const result = await listInstantlySubworkspaces(
      { fetch: fetchStub },
      { search: "  [AcMe]   TEAM  " }
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(
      result.subworkspaces.map((workspace) => workspace.id),
      [uuidFor(2), uuidFor(3)]
    );
    assert.equal(result.totalAcceptedSubworkspaces, 3);
    assert.equal(result.totalMatches, 2);
    assert.equal(result.nextStartingAfter, null);
    assert.deepEqual(result.excludedMemberships, { pending: 1, rejected: 1 });
    const empty = await listInstantlySubworkspaces(
      { fetch: fetchStub },
      { search: "No such name" }
    );
    assert.deepEqual(empty.subworkspaces, []);
    assert.equal(empty.totalMatches, 0);
    assert.equal(empty.totalAcceptedSubworkspaces, 3);
    assert.equal(empty.membershipComplete, true);
    assert.equal(empty.nextStartingAfter, null);
  });

  it("does not return an early search match when a later membership page is invalid", async () => {
    let calls = 0;
    await assert.rejects(
      listInstantlySubworkspaces(
        {
          fetch: () => {
            calls += 1;
            return calls === 1
              ? json({ items: [member()], next_starting_after: "later" })
              : json({ items: [member({ admin_workspace_id: uuidFor(1) })] });
          },
        },
        { search: "Rick" }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
    assert.equal(calls, 2);
  });

  it("bounds pages by bytes and continues without omissions when provider order changes", async () => {
    let calls = 0;
    // Each provider page fits, but the combined selected names do not.
    const records = Array.from({ length: 5 }, (_, index) =>
      member({
        id: uuidFor(index + 1),
        sub_workspace_id: uuidFor(index + 1),
        sub_workspace_name: `Team ${"x".repeat(100_000)}`,
      })
    );
    const fetchStub: typeof fetch = (address) => {
      calls += 1;
      const index = Number(
        new URL(String(address)).searchParams.get("starting_after") ?? "0"
      );
      return json({
        items: [records[index]],
        next_starting_after: index < 4 ? String(index + 1) : null,
      });
    };
    const first = await listInstantlySubworkspaces(
      { fetch: fetchStub },
      { limit: 100, search: "Team" }
    );
    assert.equal(first.subworkspaces.length, 2);
    assert.equal(first.nextStartingAfter, uuidFor(2));
    records.reverse();
    const second = await listInstantlySubworkspaces(
      { fetch: fetchStub },
      {
        limit: 100,
        search: "Team",
        startingAfter: first.nextStartingAfter ?? undefined,
      }
    );
    assert.equal(second.nextStartingAfter, uuidFor(4));
    const last = await listInstantlySubworkspaces(
      { fetch: fetchStub },
      {
        limit: 100,
        search: "Team",
        startingAfter: second.nextStartingAfter ?? undefined,
      }
    );
    assert.equal(last.nextStartingAfter, null);
    assert.equal(calls, 15);
    assert.deepEqual(
      [first, second, last].flatMap((page) =>
        page.subworkspaces.map((workspace) => workspace.id)
      ),
      [1, 2, 3, 4, 5].map(uuidFor)
    );
    for (const page of [first, second, last]) {
      assert.equal(page.totalMatches, 5);
      assert.ok(
        Buffer.byteLength(JSON.stringify(page)) <= MAX_TEST_RESPONSE_BYTES
      );
    }
  });

  it("rejects invalid discovery inputs before fetching membership", async () => {
    let calls = 0;
    const fetchStub: typeof fetch = () => {
      calls += 1;
      return json({ items: [member()] });
    };
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { search: "  " },
      { search: "x".repeat(201) },
      { startingAfter: "not-a-uuid" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential assertions verify each rejected input.
      await assert.rejects(
        listInstantlySubworkspaces({ fetch: fetchStub }, query),
        (error) => {
          assert.ok(error instanceof InstantlyApiError);
          assert.equal(error.kind, "invalid-input");
          return true;
        }
      );
    }
    assert.equal(calls, 0);
  });

  it("rejects a cursor outside the filtered results instead of silently skipping workspaces", async () => {
    await assert.rejects(
      listInstantlySubworkspaces(
        { fetch: () => json({ items: [member()] }) },
        { search: "Unmatched", startingAfter: WORKSPACE_ID }
      ),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-input");
        return true;
      }
    );
  });

  it("rejects duplicate accepted IDs rather than returning an ambiguous continuation cursor", async () => {
    await assert.rejects(
      listInstantlySubworkspaces({
        fetch: () => json({ items: [member(), member()] }),
      }),
      (error) => {
        assert.ok(error instanceof InstantlyApiError);
        assert.equal(error.kind, "invalid-response");
        return true;
      }
    );
  });
});
