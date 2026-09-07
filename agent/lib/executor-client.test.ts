import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { ConnectionAuthorizationFailedError } from "eve/connections";
import { executorClient, executorReadQuery } from "./executor/client.js";
import { operationInputs } from "./executor/operations.js";
import { readSentryIssue } from "./executor/sentry.js";
import { ExecutorError } from "./executor/transport.js";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
} from "./instantly-api.js";
import { member } from "./instantly-fixtures.js";
import { LINEAR_OPERATIONS } from "./linear-operations.js";

const ctx = {
  abortSignal: new AbortController().signal,
  getToken: () => Promise.resolve({ token: "synthetic-executor-token" }),
};
function configure(t: TestContext) {
  const prior = {
    bindings: process.env.EXECUTOR_OPERATION_BINDINGS,
    connector: process.env.EXECUTOR_MCP_CONNECTOR,
  };
  process.env.EXECUTOR_MCP_CONNECTOR = "placeholder/executor-test";
  process.env.EXECUTOR_OPERATION_BINDINGS = readFileSync(
    new URL("../../.github/executor/operation-bindings.json", import.meta.url),
    "utf8"
  );
  t.after(() => {
    if (prior.bindings === undefined) {
      delete process.env.EXECUTOR_OPERATION_BINDINGS;
    } else {
      process.env.EXECUTOR_OPERATION_BINDINGS = prior.bindings;
    }
    if (prior.connector === undefined) {
      delete process.env.EXECUTOR_MCP_CONNECTOR;
    } else {
      process.env.EXECUTOR_MCP_CONNECTOR = prior.connector;
    }
  });
}
const rpcFetch =
  (outcome: () => unknown, seen: string[]): typeof fetch =>
  (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    if (request.method === "initialize") {
      return Promise.resolve(
        Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18" },
        })
      );
    }
    seen.push(request.params.arguments.code);
    return Promise.resolve(
      Response.json({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          structuredContent: { result: outcome(), status: "completed" },
        },
      })
    );
  };

test("typed client preserves numbers, booleans, special identifiers and canonical Linear documents", async (t) => {
  configure(t);
  const seen: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    rpcFetch(() => ({ data: {}, ok: true }), seen)
  );
  const client = executorClient(ctx);
  await client({
    input: {
      latest_of_thread: false,
      lead: "a+b@example.com",
      limit: 20,
      preview_only: true,
      "x-as-workspace": "workspace",
    },
    operation: "instantly.emails",
  });
  await client({
    input: { coupon_id: "coupon / 20% & more" },
    operation: "stripe.coupons.get",
  });
  await client({
    input: { variables: { id: "doc" } },
    operation: "linear.Document",
  });
  const inputs = seen.map((code) =>
    JSON.parse(code.slice(code.indexOf("](") + 2, -2))
  );
  assert.deepEqual(inputs[0], {
    latest_of_thread: false,
    lead: "a+b@example.com",
    limit: 20,
    preview_only: true,
    "x-as-workspace": "workspace",
  });
  assert.deepEqual(inputs[1], { coupon_id: "coupon / 20% & more" });
  assert.deepEqual(inputs[2], {
    body: {
      query: LINEAR_OPERATIONS.Document.document,
      variables: { id: "doc" },
    },
  });
  assert.equal(
    seen.some((code) => code.includes("synthetic-executor-token")),
    false
  );
  assert.equal(
    operationInputs["instantly.emails"].safeParse({
      limit: "20",
      preview_only: "true",
    }).success,
    false
  );
});

for (const hint of ["60", "1", undefined]) {
  test(`full MCP failure to Instantly retry path preserves ${hint ?? "missing"} retry metadata`, async (t) => {
    configure(t);
    const seen: string[] = [];
    const waits: number[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      rpcFetch(
        () =>
          hint === "1" && seen.length > 1
            ? { data: { items: [member()] }, ok: true }
            : {
                error: {
                  code: "upstream_http_error",
                  status: 429,
                  ...(hint ? { retryAfter: hint } : {}),
                  details: { private: "provider body" },
                },
                ok: false,
              },
        seen
      )
    );
    const pending = listInstantlySubworkspaces({
      client: executorClient(ctx),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    if (hint === "1") {
      assert.equal((await pending).totalMatches, 1);
      assert.deepEqual(waits, [1000]);
      assert.equal(seen.length, 2);
    } else {
      await assert.rejects(
        pending,
        (error) =>
          error instanceof InstantlyApiError &&
          error.kind === "rate-limited" &&
          error.retryAfterSeconds === (hint ? 60 : null) &&
          !error.message.includes("private")
      );
      assert.equal(seen.length, 1);
      assert.deepEqual(waits, []);
    }
  });
}

test("outer Executor HTTP rate limits preserve retry hints through the helper", async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls += 1;
    return Promise.resolve(
      new Response("private", {
        headers: { "Retry-After": "60" },
        status: 429,
      })
    );
  });
  await assert.rejects(
    listInstantlySubworkspaces({ client: executorClient(ctx) }),
    (error) =>
      error instanceof InstantlyApiError && error.retryAfterSeconds === 60
  );
  assert.equal(calls, 1);
});

test("typed client preserves provider errors and enforces helper payload bounds", async (t) => {
  configure(t);
  const seen: string[] = [];
  let outcome: unknown = {
    error: { code: "upstream_http_error", details: "private", status: 404 },
    ok: false,
  };
  t.mock.method(
    globalThis,
    "fetch",
    rpcFetch(() => outcome, seen)
  );
  const client = executorClient(ctx);
  assert.deepEqual(
    await client({
      input: { refund_id: "re_1" },
      operation: "stripe.refunds.get",
    }),
    { data: null, status: 404 }
  );
  outcome = { data: { large: "x".repeat(1000) }, ok: true };
  await assert.rejects(
    client(
      { input: { refund_id: "re_1" }, operation: "stripe.refunds.get" },
      { maxBytes: 100 }
    )
  );
});

test("PlanetScale rejects failed and malformed results and preserves rate-limit metadata", async (t) => {
  configure(t);
  const outcomes = [
    {
      error: { code: "rate_limited", retryAfter: "60", status: 429 },
      ok: false,
    },
    {
      data: { content: [{ text: "private", type: "text" }] },
      http: { status: 503 },
      ok: true,
    },
    { data: { content: [], isError: true }, ok: true },
    { data: { content: "invalid" }, ok: true },
    { data: null, ok: true },
  ];
  let outcome: unknown;
  t.mock.method(
    globalThis,
    "fetch",
    rpcFetch(() => outcome, [])
  );
  for (const candidate of outcomes) {
    outcome = candidate;
    // biome-ignore lint/performance/noAwaitInLoops: each fixture installs its own response.
    await assert.rejects(
      executorReadQuery(ctx, {
        branch: "main",
        database: "test",
        organization: "test",
        query: "SELECT 1",
      }),
      (error) =>
        error instanceof ExecutorError &&
        (candidate.ok || (error.status === 429 && error.retryAfter === "60"))
    );
  }
});

test("Sentry preserves a provider retry hint", async (t) => {
  configure(t);
  t.mock.method(
    globalThis,
    "fetch",
    rpcFetch(
      () => ({
        error: { code: "rate_limited", retryAfter: "60", status: 429 },
        ok: false,
      }),
      []
    )
  );
  await assert.rejects(
    readSentryIssue(
      {
        issueId: "TEST-1",
        operation: "get_issue_details",
        organizationSlug: "test",
      },
      ctx
    ),
    (error) => error instanceof ExecutorError && error.retryAfter === "60"
  );
});

test("Instantly never retries a terminal company authorization failure", async (t) => {
  configure(t);
  let calls = 0;
  const failure = new ConnectionAuthorizationFailedError("executor", {
    message: "Source unavailable",
    reason: "executor_not_configured",
    retryable: false,
  });
  const client = executorClient({
    ...ctx,
    getToken: () => {
      calls += 1;
      throw failure;
    },
  });
  await assert.rejects(
    listInstantlySubworkspaces({
      client,
      sleep: () => {
        assert.fail("must not retry");
      },
    }),
    (error) => error === failure
  );
  assert.equal(calls, 1);
});
