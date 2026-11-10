import assert from "node:assert/strict";
import { test } from "node:test";
import { executorTransport } from "./transport.js";

const ACCOUNT = "acc_13f2eb62-dacf-4740-9311-c19487645ccc";
const OTHER = "acc_00000000-0000-4000-8000-000000000000";
const PATH = "foreman-inngest-api.apps.listApps";
const accountSignature = (ids: string) =>
  `(input: {\n    accountId: ${ids},\n    input: {\n      query?: { limit?: number },\n    },\n  }): Promise<{\n      accountId: "acc_output",\n    }>`;
const FLAT_SIGNATURE =
  "(input: {\n  query: { query: string },\n}): Promise<Array<unknown>>";
const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as new (
  ...args: string[]
) => (tools: unknown) => Promise<unknown>;

/** The program the transport generates for one call, as Executor receives it. */
async function program(path: string, input: Record<string, unknown>) {
  let code = "";
  await executorTransport.call(
    { signal: AbortSignal.timeout(5000), token: "t" },
    path,
    input,
    {
      fetch: (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "notifications/initialized") {
          return Promise.resolve(new Response(null, { status: 202 }));
        }
        if (request.method === "tools/call") {
          ({ code } = request.params.arguments);
        }
        return Promise.resolve(
          Response.json({
            id: request.id,
            jsonrpc: "2.0",
            result:
              request.method === "initialize"
                ? { protocolVersion: "2025-06-18" }
                : {
                    structuredContent: {
                      execution: { ok: true, value: { data: null, ok: true } },
                      status: "completed",
                    },
                  },
          })
        );
      },
    }
  );
  return code;
}

/** Runs the generated program against a v2-like tools object; the tool rejects flat input when an account is required. */
async function run(
  path: string,
  input: Record<string, unknown>,
  signature: string
) {
  const calls: unknown[] = [];
  const [slug, ...rest] = path.split(".");
  const requiresAccount = signature.includes("accountId:");
  const tools = {
    search: {
      describe: ({ paths }: { paths: string[] }) =>
        Promise.resolve({
          items: paths.map((p) => ({ description: "", path: p, signature })),
          missing: [],
          namespaces: [],
        }),
    },
    [slug as string]: {
      [rest.join(".")]: (value: Record<string, unknown>) => {
        calls.push(value);
        if (requiresAccount && !("accountId" in value)) {
          throw new Error(
            JSON.stringify({ code: "InputInvalid", message: "", status: 422 })
          );
        }
        return Promise.resolve({ received: true });
      },
    },
  };
  const result = await new AsyncFunction("tools", await program(path, input))(
    tools
  );
  return { calls, result };
}

test("a tool whose app has one linked account is called as { accountId, input }", async () => {
  const input = { query: { limit: 1 } };
  const { calls, result } = await run(
    PATH,
    input,
    accountSignature(`"${ACCOUNT}"`)
  );
  assert.deepEqual(calls, [{ accountId: ACCOUNT, input }]);
  assert.deepEqual(result, { data: { received: true }, ok: true });
});

test("a tool without accounts gets its input unchanged", async () => {
  const input = { query: { query: "invoices" } };
  const { calls, result } = await run(
    "foreman-help-api.search.searchHelpCenter",
    input,
    FLAT_SIGNATURE
  );
  assert.deepEqual(calls, [input]);
  assert.deepEqual(result, { data: { received: true }, ok: true });
});

test("more than one account is refused before any call", async () => {
  const { calls, result } = await run(
    PATH,
    { query: {} },
    accountSignature(`"${ACCOUNT}" | "${OTHER}"`)
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    error: { code: "executor_account_ambiguous" },
    ok: false,
  });
});

test("caller input never chooses the account", async () => {
  const signature = accountSignature(`"${ACCOUNT}"`);
  // An accountId field inside ordinary input is data, wrapped like any other field.
  const typed = { accountId: OTHER, query: {} };
  assert.deepEqual((await run(PATH, typed, signature)).calls, [
    { accountId: ACCOUNT, input: typed },
  ]);
  // Input already shaped after describe passes through only for the described account.
  const canonical = { accountId: ACCOUNT, input: { query: {} } };
  assert.deepEqual((await run(PATH, canonical, signature)).calls, [canonical]);
  const foreign = await run(
    PATH,
    { accountId: OTHER, input: { query: {} } },
    signature
  );
  assert.deepEqual(foreign.calls, []);
  assert.deepEqual(foreign.result, {
    error: { code: "executor_account_mismatch" },
    ok: false,
  });
});
