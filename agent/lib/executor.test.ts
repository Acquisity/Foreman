import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SessionAuthContext, SessionContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { bindOperation } from "./executor/bindings.js";
import { executorConnection } from "./executor/connection.js";
import { providerAllowlist } from "./executor/policy.js";
import { EXECUTOR_PROFILES, executorProfile } from "./executor/profiles.js";
import {
  authorizeHelper,
  resolveProviderRequest,
} from "./executor/requests.js";
import { readSentryIssue, sentryIssueInput } from "./executor/sentry.js";
import { ExecutorError, invokeExecutor } from "./executor/transport.js";
import {
  AUTONOMOUS_PRINCIPAL,
  stampInvestigationMemory,
  stampTrusted,
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
const INVALID_ARGUMENT = /invalid_binding_argument/u;
const OPERATION = "stripe.org.foreman.customer";
test("verified catalog coercions preserve bounded query values and reject ambiguous inputs", () => {
  const previous = process.env.EXECUTOR_OPERATION_BINDINGS;
  process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
    probe: {
      arguments: {
        expand: "query.expand",
        limit: "query.limit",
        preview_only: "query.preview_only",
      },
      coercions: { expand: "single", limit: "number", preview_only: "boolean" },
      path: OPERATION,
    },
  });
  try {
    assert.deepEqual(
      bindOperation("probe", {
        query: { expand: ["refunds"], limit: "20", preview_only: "true" },
      }).input,
      { expand: "refunds", limit: 20, preview_only: true }
    );
    for (const query of [
      { limit: "" },
      { limit: "Infinity" },
      { limit: "20garbage" },
      { preview_only: "yes" },
      { expand: ["refunds", "customer"] },
    ]) {
      assert.throws(() => bindOperation("probe", { query }), INVALID_ARGUMENT);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.EXECUTOR_OPERATION_BINDINGS;
    } else {
      process.env.EXECUTOR_OPERATION_BINDINGS = previous;
    }
  }
});
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

test("profile selection follows channel stamps and preserves unattended authority", () => {
  assert.equal(executorProfile(internal), "attended");
  assert.equal(executorProfile(auth), "limited");
  assert.equal(executorProfile(factory), "factory");
  assert.equal(executorProfile(stampUnattended(internal)), "scheduled");
  assert.equal(
    executorProfile(stampUnattended(stampTrusted(auth))),
    "scheduled-internal"
  );
  assert.equal(executorProfile(null), "limited");
});

test("a requester other than Aaron can use shared attended auth without provider consent", () => {
  const connection = executorConnection("root", "attended");
  assert.equal(typeof connection.auth, "function");
  const resolve = connection.auth as (ctx: SessionContext) => {
    principalType?: string;
  };
  const resolved = resolve({
    session: { auth: { current: internal } },
  } as SessionContext);
  assert.equal(resolved.principalType, "app");
  assert.equal("startAuthorization" in resolved, false);
});

test("wrong-profile discovery and direct calls are both denied", () => {
  for (const profile of EXECUTOR_PROFILES) {
    if (profile === "attended") {
      continue;
    }
    const connection = executorConnection("root", profile);
    const ctx = {
      session: { auth: { current: internal } },
      toolInput: { profile },
      toolName: "execute",
    };
    assert.throws(() =>
      (connection.auth as (ctx: SessionContext) => unknown)(
        ctx as unknown as SessionContext
      )
    );
    const result = (
      connection.approval as (ctx: ApprovalContext) => { type: string }
    )(ctx as unknown as ApprovalContext);
    assert.equal(result.type, "denied");
  }
});

test("critic and unattended policy contracts retain their narrower provider operations", () => {
  assert.ok(
    providerAllowlist("vercel", "root", "attended").includes("deploy_to_vercel")
  );
  assert.ok(
    providerAllowlist("openrouter", "root", "attended").includes("send-message")
  );
  assert.ok(
    !providerAllowlist("vercel", "critic", "attended").includes(
      "deploy_to_vercel"
    )
  );
  assert.ok(
    !providerAllowlist("openrouter", "root", "factory").includes("send-message")
  );
  for (const role of ["root", "critic"] as const) {
    for (const profile of EXECUTOR_PROFILES) {
      assert.deepEqual(providerAllowlist("linear", role, profile), ["*"]);
    }
  }
  assert.deepEqual(providerAllowlist("intercom", "root", "limited"), []);
  assert.ok(
    providerAllowlist("intercom", "root", "factory").includes(
      "get_conversation"
    )
  );
  assert.deepEqual(providerAllowlist("supermemory", "root", "attended"), []);
});

test("helper request mapping preserves billing expansions and excludes credentials", () => {
  const request = resolveProviderRequest(
    "autumn",
    "https://api.useautumn.com/v1/customers.get",
    {
      body: JSON.stringify({
        customer_id: "account",
        expand: ["subscriptions.plan"],
      }),
      headers: { authorization: "never-forward", "x-api-version": "2.3.0" },
      method: "POST",
    }
  );
  assert.equal(request.operation, "autumn.customer");
  assert.deepEqual(request.source.body, {
    customer_id: "account",
    expand: ["subscriptions.plan"],
  });
  assert.deepEqual(request.source.headers, { "x-api-version": "2.3.0" });
});

test("fixed request mapping refuses arbitrary endpoints and mutation routes", () => {
  assert.throws(() =>
    resolveProviderRequest("stripe", "https://attacker.invalid/v1/charges", {})
  );
  assert.throws(() =>
    resolveProviderRequest("stripe", "https://api.stripe.com/v1/refunds", {
      method: "POST",
    })
  );
  assert.throws(() =>
    resolveProviderRequest("linear", "https://api.linear.app/graphql", {
      body: JSON.stringify({ query: "mutation DeleteEverything { delete }" }),
      method: "POST",
    })
  );
});

test("Instantly routing retains workspace provenance and bounded query flags", () => {
  const request = resolveProviderRequest(
    "instantly",
    "https://api.instantly.ai/api/v2/emails?limit=20&preview_only=true",
    { headers: { "x-as-workspace": "member-id" } }
  );
  assert.equal(request.operation, "instantly.emails");
  assert.deepEqual(request.source.query, { limit: "20", preview_only: "true" });
  assert.deepEqual(request.source.headers, { "x-as-workspace": "member-id" });
});

test("helper runtime denials apply before any transport", () => {
  assert.doesNotThrow(() => authorizeHelper("linear.RelatedIssues", factory));
  for (const current of [
    null,
    auth,
    internal,
    factory,
    stampUnattended(auth),
  ]) {
    for (const operation of [
      "linear.RelatedIssues",
      "linear.CreateDocument",
      "linear.RouteIssueUpdate",
    ]) {
      assert.doesNotThrow(() => authorizeHelper(operation, current));
    }
  }
  assert.throws(() => authorizeHelper("instantly.accounts", auth));
  assert.throws(() =>
    authorizeHelper("stripe.customers.get", {
      ...auth,
      principalId: "github:outsider",
    })
  );
  assert.doesNotThrow(() =>
    authorizeHelper("linear.RouteIssueUpdate", internal)
  );
});

test("operation bindings map exact argument fields and fail closed on unknown mappings", () => {
  const old = process.env.EXECUTOR_OPERATION_BINDINGS;
  try {
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      "stripe.customers.get": {
        arguments: { "path.customer": "path.id", query: "query" },
        path: OPERATION,
      },
    });
    assert.deepEqual(
      bindOperation("stripe.customers.get", {
        path: { id: "cus_1" },
        query: { limit: "20" },
      }),
      {
        input: { path: { customer: "cus_1" }, query: { limit: "20" } },
        path: OPERATION,
      }
    );
    assert.throws(() => bindOperation("stripe.refunds.get", {}));
    process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
      bad: { arguments: { "__proto__.polluted": "body" }, path: OPERATION },
    });
    assert.throws(() => bindOperation("bad", { body: true }));
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  } finally {
    if (old === undefined) {
      delete process.env.EXECUTOR_OPERATION_BINDINGS;
    } else {
      process.env.EXECUTOR_OPERATION_BINDINGS = old;
    }
  }
});

test("Executor uses a fresh toolkit session, follows JSON-RPC ids, and returns the structured provider payload", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const result = await invokeExecutor(
    context(),
    OPERATION,
    { customer: 'value"; throw new Error("injection"); //' },
    { fetch: rpc(completed({ id: "cus_1" }), seen) }
  );
  assert.deepEqual(result, { data: { id: "cus_1" }, ok: true });
  assert.equal(seen.length, 3);
  assert.ok(
    seen.every((call) => call.url.includes("/foreman-helpers-attended?"))
  );
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
  const outcome = await invokeExecutor(
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
      invokeExecutor(context(), OPERATION, {}, { fetch: rpc(result, seen) }),
      ExecutorError
    );
    assert.equal(seen.length, 3);
  }
  await assert.rejects(
    invokeExecutor(
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
    invokeExecutor(
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
    invokeExecutor(
      { ...context(), signal: abort.signal },
      OPERATION,
      {},
      { fetch: fetchStub }
    )
  );
  assert.equal(cancelled, true);
});

test("the active connection rejects guessed resume and management tools", () => {
  const connection = executorConnection("root", "attended");
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

test("a fresh invocation cannot reuse another profile's MCP session", async () => {
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
  await invokeExecutor(context(), OPERATION, {}, { fetch: fetchStub });
  await invokeExecutor(context(factory), OPERATION, {}, { fetch: fetchStub });
  assert.equal(initialHeaders.length, 2);
  assert.ok(initialHeaders.every((headers) => !headers.has("mcp-session-id")));
  assert.ok(endpoints[0].includes("helpers-attended"));
  assert.ok(endpoints[1].includes("helpers-factory"));
});

test("the deadline cancels a stalled response body without a caller cancellation", async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    await assert.rejects(
      invokeExecutor(
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

test("installed toolkit manifest shares Linear access across every execution profile", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../.github/executor/toolkit-manifest.json", import.meta.url),
      "utf8"
    )
  ) as {
    toolkits: Array<{ slug: string; role: string; paths: string[] }>;
  };
  const linearPaths = (paths: string[]) =>
    paths.filter(
      (path) => path.startsWith("linear.") || path.startsWith("foreman_linear_")
    );
  const root = manifest.toolkits.find(
    (toolkit) => toolkit.slug === "foreman-root-attended"
  );
  const helpers = manifest.toolkits.find(
    (toolkit) => toolkit.slug === "foreman-helpers-attended"
  );
  assert.ok(root);
  assert.ok(helpers);
  assert.ok(root.paths.some((path) => path.endsWith(".save_issue")));
  assert.ok(
    helpers.paths.some((path) => path.startsWith("foreman_linear_write_api."))
  );
  for (const toolkit of manifest.toolkits) {
    assert.deepEqual(
      linearPaths(toolkit.paths),
      linearPaths(toolkit.role === "helpers" ? helpers.paths : root.paths),
      toolkit.slug
    );
  }
});
