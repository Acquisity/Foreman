import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { postWidgetAppRoute } from "./widget-app-diagnostics.js";
import { widgetAuth } from "./widget-scope.js";

const unconfigured = /not configured/;

const ctx = {
  abortSignal: new AbortController().signal,
  session: { auth: { initiator: widgetAuth(verifiedWidgetContext) } },
};
test("app routes send the verified chat's scope to the fixed origin, over any input, and refuse redirects", async (t) => {
  const before = {
    origin: process.env.ACQUISITY_ORIGIN,
    secret: process.env.FOREMAN_DIAGNOSTICS_SECRET,
  };
  process.env.ACQUISITY_ORIGIN = "https://app.test";
  process.env.FOREMAN_DIAGNOSTICS_SECRET = "x".repeat(32);
  t.after(() => {
    for (const [key, value] of [
      ["ACQUISITY_ORIGIN", before.origin],
      ["FOREMAN_DIAGNOSTICS_SECRET", before.secret],
    ]) {
      if (value === undefined) {
        delete process.env[key as string];
      } else {
        process.env[key as string] = value;
      }
    }
  });
  const request = ((url, init) => {
    assert.equal(url, "https://app.test/api/internal/foreman/website");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${"x".repeat(32)}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(
      JSON.parse(String(init?.body)).userId,
      verifiedWidgetContext.userId
    );
    assert.equal(
      JSON.parse(String(init?.body)).organizationId,
      verifiedWidgetContext.organizationId
    );
    assert.ok(init?.signal);
    return Promise.resolve(Response.json({ status: "ok" }));
  }) as typeof fetch;
  const { response } = await postWidgetAppRoute(
    ctx,
    "/api/internal/foreman/website",
    { organizationId: "other", userId: "other" },
    25_000,
    request
  );
  assert.deepEqual(await response.json(), { status: "ok" });
  delete process.env.FOREMAN_DIAGNOSTICS_SECRET;
  await assert.rejects(
    postWidgetAppRoute(
      ctx,
      "/api/internal/foreman/website",
      {},
      25_000,
      request
    ),
    unconfigured
  );
});
