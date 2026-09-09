import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionAuthContext, SessionContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { operationPath } from "./executor/bindings.js";
import { executorConnection } from "./executor/connection.js";
import { FOREMAN_TOOLKIT_SLUG, toolkitUrl } from "./executor/endpoint.js";

import { readSentryIssue, sentryIssueInput } from "./executor/sentry.js";
import { ExecutorError, executorTransport } from "./executor/transport.js";
import {
  AUTONOMOUS_PRINCIPAL,
  stampInvestigationMemory,
  stampUnattended,
} from "./trust.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "linear:another-requester",
  principalType: "user",
};
const internal = stampInvestigationMemory(auth);
const factory = { ...auth, principalId: AUTONOMOUS_PRINCIPAL };
const completed = (data: unknown) => ({
  structuredContent: { result: { data, ok: true }, status: "completed" },
});
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
const OPERATION = "stripe.org.foreman.customer";
const rpc =
  (
    toolResult: unknown,
    seen: { url: string; init: RequestInit }[] = [],
    sse = false
  ): typeof fetch =>
  (url, init = {}) => {
    seen.push({ init, url: String(url) });
    const request = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
    };
    if (request.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    const body = {
      id: request.id,
      jsonrpc: "2.0",
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : toolResult,
    };
    return Promise.resolve(
      sse
        ? new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "session",
            },
          })
        : json(body, { "mcp-session-id": "session" })
    );
  };
const context = (current: SessionAuthContext | null = internal) => ({
  auth: current,
  signal: new AbortController().signal,
  token: "executor-secret",
});

process.env.EXECUTOR_MCP_CONNECTOR = "executor/test";

test("every execution context shares company auth and the same toolkit", () => {
  const connection = executorConnection();
  assert.equal(connection.url, toolkitUrl());
  for (const current of [
    null,
    auth,
    internal,
    factory,
    stampUnattended(auth),
  ]) {
    const resolved = (
      connection.auth as (ctx: SessionContext) => { principalType?: string }
    )({ session: { auth: { current } } } as SessionContext);
    assert.equal(resolved.principalType, "app");
    assert.equal("startAuthorization" in resolved, false);
    for (const toolName of ["execute", "skills", "executor__execute"]) {
      assert.equal(
        (connection.approval as (ctx: ApprovalContext) => unknown)({
          session: { auth: { current } },
          toolName,
        } as ApprovalContext),
        "not-applicable"
      );
    }
  }
});

test("deployment bindings select paths and cannot modify typed arguments", async () => {
  const previous = process.env.EXECUTOR_OPERATION_BINDINGS;
  try {
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      read: { arguments: { secret: "other" }, path: OPERATION },
    });
    assert.equal(operationPath("read"), OPERATION);
    const seen: { url: string; init: RequestInit }[] = [];
    await executorTransport.call(
      context(),
      operationPath("read"),
      { customer: "cus_1" },
      { fetch: rpc(completed({}), seen) }
    );
    const invocation = JSON.parse(String(seen[2].init.body));
    assert.ok(
      invocation.params.arguments.code.includes(
        JSON.stringify({ customer: "cus_1" })
      )
    );
    assert.ok(!invocation.params.arguments.code.includes("secret"));
    assert.ok(!invocation.params.arguments.code.includes("other"));
    for (const invalid of [
      "{",
      JSON.stringify({ read: { path: "invalid" } }),
    ]) {
      process.env.EXECUTOR_OPERATION_BINDINGS = invalid;
      assert.throws(
        () => operationPath("read"),
        (error) =>
          error instanceof ExecutorError &&
          error.code === "invalid_operation_bindings"
      );
    }
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      read: { path: OPERATION },
    });
    assert.throws(() => operationPath("missing"));
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      read: { path: "executor.coreTools.policies.delete" },
    });
    assert.throws(() => operationPath("read"));
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_OPERATION_BINDINGS;
    } else {
      process.env.EXECUTOR_OPERATION_BINDINGS = previous;
    }
  }
});

test("Executor uses a fresh toolkit session, follows JSON-RPC ids, and returns the structured provider payload", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const result = await executorTransport.call(
    context(),
    OPERATION,
    { customer: 'value"; throw new Error("injection"); //' },
    { fetch: rpc(completed({ id: "cus_1" }), seen) }
  );
  assert.deepEqual(result, { data: { id: "cus_1" }, ok: true });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((call) => call.url.includes("/foreman?")));
  assert.ok(
    seen.every(
      (call) =>
        new Headers(call.init.headers).get("authorization") ===
        "Bearer executor-secret"
    )
  );
  assert.ok(seen.every((call) => call.init.redirect === "error"));
  const invocation = JSON.parse(String(seen[2].init.body));
  assert.equal(invocation.params.name, "execute");
  assert.ok(!invocation.params.arguments.code.includes("executor-secret"));
  assert.ok(
    invocation.params.arguments.code.includes(
      JSON.stringify('value"; throw new Error("injection"); //')
    )
  );
});

test("SSE responses and provider HTTP failures are handled without exposing provider error bodies", async () => {
  const outcome = await executorTransport.call(
    context(),
    OPERATION,
    {},
    {
      fetch: rpc(
        {
          structuredContent: {
            result: {
              error: {
                code: "not_found",
                message: "private-provider-body",
                status: 404,
              },
              ok: false,
            },
            status: "completed",
          },
        },
        [],
        true
      ),
    }
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.deepEqual(outcome.error, { code: "not_found", status: 404 });
  }
});

test("paused, malformed, and management calls fail without resuming or retrying", async () => {
  for (const result of [
    { structuredContent: { resumePayload: {}, status: "paused" } },
    completed(undefined),
    { isError: true },
  ]) {
    const seen: { url: string; init: RequestInit }[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: each fixture verifies its own complete handshake.
    await assert.rejects(
      executorTransport.call(
        context(),
        OPERATION,
        {},
        { fetch: rpc(result, seen) }
      ),
      ExecutorError
    );
    assert.equal(seen.length, 3);
  }
  await assert.rejects(
    executorTransport.call(
      context(),
      "executor.coreTools.policies.create",
      {},
      { fetch: rpc(completed({})) }
    ),
    ExecutorError
  );
});

test("size limits reject oversized transport payloads before parsing", async () => {
  await assert.rejects(
    executorTransport.call(
      context(),
      OPERATION,
      {},
      { fetch: rpc(completed({ huge: "x".repeat(2000) })), maxBytes: 1024 }
    ),
    ExecutorError
  );
});

test("cancellation during a stalled response cancels the reader and stops the call", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const fetchStub: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
        start() {
          abort.abort(new Error("cancelled"));
        },
      })
    );
  await assert.rejects(
    executorTransport.call(
      { ...context(), signal: abort.signal },
      OPERATION,
      {},
      { fetch: fetchStub }
    )
  );
  assert.equal(cancelled, true);
});

test("the active connection rejects guessed resume and management tools", () => {
  const connection = executorConnection();
  for (const toolName of [
    "resume",
    "executor__resume",
    "create_api_key",
    "read_artifact",
  ]) {
    const result = (
      connection.approval as (ctx: ApprovalContext) => { type: string }
    )({
      session: { auth: { current: internal } },
      toolInput: {},
      toolName,
    } as unknown as ApprovalContext);
    assert.equal(result.type, "denied");
  }
});

test("helper invocations use fresh sessions on the same shared toolkit", async () => {
  const initialHeaders: Headers[] = [];
  const endpoints: string[] = [];
  const responder = rpc(completed({}));
  const fetchStub: typeof fetch = (url, init = {}) => {
    if (JSON.parse(String(init.body)).method === "initialize") {
      initialHeaders.push(new Headers(init.headers));
      endpoints.push(String(url));
    }
    return responder(url, init);
  };
  await executorTransport.call(context(), OPERATION, {}, { fetch: fetchStub });
  await executorTransport.call(
    context(factory),
    OPERATION,
    {},
    { fetch: fetchStub }
  );
  assert.equal(initialHeaders.length, 2);
  assert.ok(initialHeaders.every((headers) => !headers.has("mcp-session-id")));
  assert.equal(endpoints[0], toolkitUrl());
  assert.equal(endpoints[1], toolkitUrl());
});

test("the deadline cancels a stalled response body without a caller cancellation", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(
      executorTransport.call(
        context(),
        OPERATION,
        {},
        {
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              })
            ),
          timeoutMs: 10,
        }
      ),
      (error: unknown) =>
        error instanceof Error && error.name === "TimeoutError"
    );
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("critic Sentry helper refuses arbitrary nested operations before authentication", async () => {
  await Promise.all(
    ["update_issue", "create_project", "analyze_issue_with_seer"].map(
      (operation) =>
        assert.rejects(
          readSentryIssue(
            { issueId: "TEST-1", operation, organizationSlug: "acquisity-ai" },
            {} as never
          )
        )
    )
  );
  assert.equal(
    sentryIssueInput.safeParse({
      arguments: { name: "update_issue" },
      issueId: "TEST-1",
      operation: "get_issue_details",
      organizationSlug: "acquisity-ai",
    }).success,
    false
  );
  assert.equal(
    sentryIssueInput.safeParse({
      issueId: "TEST-1",
      limit: 101,
      operation: "search_issue_events",
      organizationSlug: "acquisity-ai",
    }).success,
    false
  );
});

test("one toolkit contains platform operations and every helper binding", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../.github/executor/toolkit-manifest.json", import.meta.url),
      "utf8"
    )
  ) as { toolkit: { slug: string; paths: string[] } };
  const bindings = JSON.parse(
    readFileSync(
      new URL(
        "../../.github/executor/operation-bindings.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as Record<string, { path: string }>;
  const { toolkit } = manifest;
  assert.equal(toolkit.slug, FOREMAN_TOOLKIT_SLUG);
  assert.equal(new Set(toolkit.paths).size, toolkit.paths.length);
  for (const binding of Object.values(bindings)) {
    assert.ok(toolkit.paths.includes(binding.path), binding.path);
  }
  for (const suffix of [".save_issue", ".send_message", ".get_conversation"]) {
    assert.ok(
      toolkit.paths.some((path) => path.endsWith(suffix)),
      suffix
    );
  }
  assert.ok(
    toolkit.paths.every(
      (path) =>
        !(path.startsWith("supermemory.") || path.startsWith("executor."))
    )
  );
});
