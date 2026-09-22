import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { readWidgetAppDiagnostics } from "./widget-app-diagnostics.js";
import { widgetAuth } from "./widget-scope.js";

const forbidden = /403/;
const oversized = /too large/;
const unconfigured = /not configured/;

const ctx = {
  abortSignal: new AbortController().signal,
  session: { auth: { initiator: widgetAuth(verifiedWidgetContext) } },
};
test("app diagnostics send trusted scope to a fixed origin and refuse redirects/oversized replies", async (t) => {
  const before = {
    origin: process.env.ACQUISITY_FIN_ORIGIN,
    secret: process.env.FOREMAN_DIAGNOSTICS_SECRET,
  };
  process.env.ACQUISITY_FIN_ORIGIN = "https://app.test";
  process.env.FOREMAN_DIAGNOSTICS_SECRET = "x".repeat(32);
  t.after(() => {
    for (const [key, value] of [
      ["ACQUISITY_FIN_ORIGIN", before.origin],
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
    assert.equal(url, "https://app.test/api/internal/foreman/calendar");
    assert.equal(init?.redirect, "error");
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
  assert.deepEqual(
    await readWidgetAppDiagnostics(
      ctx,
      "calendar",
      { organizationId: "other", userId: "other" },
      request
    ),
    { status: "ok" }
  );
  await assert.rejects(
    readWidgetAppDiagnostics(ctx, "calendar", {}, (() =>
      Promise.resolve(
        new Response("not authorized", { status: 403 })
      )) as typeof fetch),
    forbidden
  );
  await assert.rejects(
    readWidgetAppDiagnostics(ctx, "calendar", {}, (() =>
      Promise.resolve(new Response("x".repeat(65_537)))) as typeof fetch),
    oversized
  );
  delete process.env.FOREMAN_DIAGNOSTICS_SECRET;
  await assert.rejects(
    readWidgetAppDiagnostics(ctx, "calendar", {}, request),
    unconfigured
  );
});
