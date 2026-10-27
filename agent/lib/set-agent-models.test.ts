import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { type TestContext, test } from "node:test";
import { gateway } from "ai";

// Replace only storage; the real tool, model routing and catalog parsing run.
const blobStub = `data:text/javascript,${encodeURIComponent(`
export const writes = [];
export class BlobNotFoundError extends Error {}
export const get = async () => ({
  stream: new Response('{"vision":"google/existing"}').body,
  blob: { uploadedAt: new Date(0) }
});
export const put = async (key, content) => { writes.push({ key, content }); };
export const head = async () => {};
export const del = async () => {};
`)}`;
const hooks = registerHooks({
  resolve(specifier, resolution, next) {
    return specifier === "@vercel/blob"
      ? { shortCircuit: true, url: blobStub }
      : next(specifier, resolution);
  },
});
const { default: tool } = await import("../tools/set_agent_models.js");
const { listProxyModels, modelFor } = await import("./models.js");
const { writes } = (await import(blobStub)) as {
  writes: { content: string; key: string }[];
};
hooks.deregister();

type Context = Parameters<typeof tool.execute>[1];
const context = {} as Context;

const catalogs = (t: TestContext, proxyResponse: () => Promise<Response>) => {
  for (const [key, value] of Object.entries({
    CLIPROXY_API_KEY: "test-proxy-key",
    CLIPROXY_BASE_URL: "https://proxy.test/v1",
  })) {
    const saved = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    });
  }
  writes.length = 0;
  const { timeout } = AbortSignal;
  const deadlines = new Map<AbortSignal, number>();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const signal = timeout(ms);
    deadlines.set(signal, ms);
    return signal;
  });
  const gatewayRead = t.mock.method(
    gateway,
    "getAvailableModels",
    async () => ({
      models: [
        { id: "anthropic/claude-haiku-4.5", name: "Haiku" },
        { id: "google/gemini-3.6-flash", name: "Gemini" },
      ],
    })
  );
  const proxyRead = t.mock.method(
    globalThis,
    "fetch",
    (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, "https://proxy.test/v1/models");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-proxy-key"
      );
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(deadlines.get(init.signal), 10_000);
      return proxyResponse();
    }
  );
  return { gatewayRead, proxyRead };
};

test("refuses a gateway-listed Claude override absent from the proxy without writing", async (t) => {
  const reads = catalogs(t, async () =>
    Response.json({ data: [{ id: "claude-fable-5-1" }] })
  );
  assert.deepEqual(
    await tool.execute({ widgetSteps: "anthropic/claude-haiku-4.5" }, context),
    {
      error: "Not in the CLI Proxy catalog: anthropic/claude-haiku-4.5.",
      success: false,
    }
  );
  assert.deepEqual(writes, []);
  assert.equal(reads.gatewayRead.mock.callCount(), 0);
  assert.equal(reads.proxyRead.mock.callCount(), 1);
});

test("accepts a Claude override listed by its mapped proxy name and preserves other overrides", async (t) => {
  const reads = catalogs(t, async () =>
    Response.json({ data: [{ id: "claude-fable-5-1" }] })
  );
  const result = await tool.execute(
    { critic: "anthropic/claude-fable-5.1" },
    context
  );
  assert.ok("success" in result);
  assert.equal(result.success, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, "model-overrides/foreman.json");
  assert.deepEqual(JSON.parse(writes[0].content), {
    critic: "anthropic/claude-fable-5.1",
    vision: "google/existing",
  });
  assert.equal(reads.gatewayRead.mock.callCount(), 0);
  assert.equal(reads.proxyRead.mock.callCount(), 1);
});

test("refuses a failed proxy catalog read without writing or exposing its error", async (t) => {
  catalogs(t, () =>
    Promise.reject(new Error("test-proxy-key private response text"))
  );
  assert.deepEqual(
    await tool.execute({ critic: "anthropic/claude-fable-5.1" }, context),
    {
      error: "Could not verify model ids against the CLI Proxy catalog.",
      success: false,
    }
  );
  assert.deepEqual(writes, []);
});

test("validates a non-Claude override only against the gateway", async (t) => {
  const reads = catalogs(t, () =>
    Promise.reject(new Error("Proxy must not be called"))
  );
  const result = await tool.execute(
    { vision: "google/gemini-3.6-flash" },
    context
  );
  assert.ok("success" in result);
  assert.equal(result.success, true);
  assert.equal(writes.length, 1);
  assert.equal(reads.gatewayRead.mock.callCount(), 1);
  assert.equal(reads.proxyRead.mock.callCount(), 0);
});

for (const [scenario, response] of [
  [
    "HTTP failure",
    () => new Response("test-proxy-key private body", { status: 503 }),
  ],
  ["malformed catalog", () => Response.json({ data: [{ id: 123 }] })],
] as const) {
  test(`refuses a proxy ${scenario} without writing or exposing its body`, async (t) => {
    catalogs(t, async () => response());
    assert.deepEqual(
      await tool.execute({ critic: "anthropic/claude-fable-5.1" }, context),
      {
        error: "Could not verify model ids against the CLI Proxy catalog.",
        success: false,
      }
    );
    assert.deepEqual(writes, []);
  });
}

test("writes nothing when a mixed override request fails gateway validation", async (t) => {
  const reads = catalogs(t, async () =>
    Response.json({ data: [{ id: "claude-fable-5-1" }] })
  );
  assert.deepEqual(
    await tool.execute(
      { critic: "anthropic/claude-fable-5.1", vision: "google/unknown" },
      context
    ),
    { error: "Not in the gateway catalog: google/unknown.", success: false }
  );
  assert.deepEqual(writes, []);
  assert.equal(reads.gatewayRead.mock.callCount(), 1);
  assert.equal(reads.proxyRead.mock.callCount(), 1);
});

test("restores a default without reading either catalog", async (t) => {
  const reads = catalogs(t, () =>
    Promise.reject(new Error("Proxy must not be called"))
  );
  const result = await tool.execute({ vision: null }, context);
  assert.ok("success" in result);
  assert.equal(result.success, true);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].content), {});
  assert.equal(reads.gatewayRead.mock.callCount(), 0);
  assert.equal(reads.proxyRead.mock.callCount(), 0);
});

test("requires the same proxy configuration for catalog reads and Claude calls", async (t) => {
  const reads = catalogs(t, () =>
    Promise.reject(new Error("Proxy must not be called"))
  );
  delete process.env.CLIPROXY_API_KEY;
  const missing = {
    message:
      "Claude models need the CLI Proxy: set CLIPROXY_BASE_URL and CLIPROXY_API_KEY",
  };
  assert.throws(() => modelFor("anthropic/claude-fable-5.1"), missing);
  await assert.rejects(listProxyModels, missing);
  assert.equal(reads.proxyRead.mock.callCount(), 0);
});
