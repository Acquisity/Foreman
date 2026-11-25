import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ToolContext } from "eve/tools";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import { liveTool } from "./widget-live-tool.js";
import { widgetAuth } from "./widget-scope.js";

const orders = WIDGET_ENDPOINT_MANIFEST.endpoints.find(
  ({ name }) => name === "orders"
);
assert.ok(orders);
const listed = {
  name: orders.name,
  path: orders.path,
  sections: orders.sections.map((section) => section.name),
  version: orders.version,
};
const ctxFor = (endpoints = [listed]) => {
  const auth = widgetAuth({ ...verifiedWidgetContext, endpoints });
  return {
    abortSignal: new AbortController().signal,
    session: { auth: { current: auth, initiator: auth } },
  } as unknown as ToolContext;
};

function configure(context: TestContext) {
  for (const [name, value] of [
    ["ACQUISITY_ORIGIN", "https://pr-1-acquisity.vercel.app"],
    ["FOREMAN_DIAGNOSTICS_SECRET", "s".repeat(40)],
  ] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    context.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
  }
}

test("a switched area's recorded read is re-issued through its endpoint with the recorded input and the verified scope", async (context) => {
  configure(context);
  const body = { sections: {}, status: "ok", unavailable: [] };
  const requests: { body: unknown; url: string }[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (url: unknown, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return Promise.resolve(Response.json(body));
    }
  );
  const ctx = ctxFor();
  const tool = await liveTool("widget_orders", ctx, new Set());
  assert.ok(tool);
  const input = { orderId: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(await tool.execute(input, ctx), body);
  const [sent] = requests;
  assert.ok(sent);
  assert.equal(sent.url, `https://pr-1-acquisity.vercel.app${orders.path}`);
  const posted = sent.body as Record<string, unknown>;
  assert.equal(posted.orderId, input.orderId);
  assert.equal(posted.organizationId, verifiedWidgetContext.organizationId);
});

test("a held area, or an endpoint the recorded scope never listed, is not re-read through an endpoint", async () => {
  // Held: the generated name has no file of its own, so the re-read fails and is reported unverifiable.
  await assert.rejects(
    liveTool("widget_orders", ctxFor(), new Set(["orders"]))
  );
  await assert.rejects(liveTool("widget_orders", ctxFor([]), new Set()));
  // A held area's old tool still resolves from its file.
  assert.ok(await liveTool("widget_provisioning_status", ctxFor()));
});
