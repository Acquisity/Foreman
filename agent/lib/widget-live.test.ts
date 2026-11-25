import assert from "node:assert/strict";
import { test } from "node:test";
import billingDefinition from "../tools/widget_billing_summary.js";
import ticketDefinition from "../tools/widget_file_ticket.js";
import outreachDefinition from "../tools/widget_outreach_health.js";
import { executorTransport } from "./executor/transport.js";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { filedTicketResult } from "./widget-investigation.js";
import {
  datedTools,
  driftVerdict,
  gapSentences,
  readResult,
  replyElapsed,
} from "./widget-live.js";
import {
  assertLiveAllowed,
  hasMovingWindow,
  LIVE_PROTOCOL,
  LIVE_TICKET,
  liveContext,
  liveServerUrl,
  liveToolInput,
  pinLiveInput,
  verifyLiveServer,
} from "./widget-live-policy.js";
import { widgetAuth } from "./widget-scope.js";

const LOCAL_ONLY = /local-only/;
const LOOPBACK = /loopback/;
const NOT_LIVE = /not running/;

test("live mode refuses all Vercel deployments and verifies loopback admission before customer data", async () => {
  for (const VERCEL_ENV of ["production", "preview", "development", ""]) {
    assert.throws(
      () => assertLiveAllowed({ VERCEL_ENV, WIDGET_LIVE: "1" }),
      LOCAL_ONLY
    );
  }
  assertLiveAllowed({ WIDGET_LIVE: "1" });
  let requests = 0;
  const probe: typeof fetch = (url, options) => {
    requests += 1;
    assert.equal(url, "http://127.0.0.1:3242/internal/widget/live");
    assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get("authorization"), null);
    assert.equal(options?.redirect, "error");
    return Promise.resolve(new Response(LIVE_PROTOCOL));
  };
  await verifyLiveServer("http://127.0.0.1:3242", "test-secret", probe);
  await Promise.all(
    [
      "https://foreman.example",
      "http://localhost.evil.example",
      "http://127.0.0.1/path",
      "http://user@localhost",
    ].map((url) =>
      assert.rejects(verifyLiveServer(url, "test-secret", probe), LOOPBACK)
    )
  );
  assert.equal(requests, 1);
  assert.equal(liveServerUrl("http://[::1]:2000"), "http://[::1]:2000");
  await assert.rejects(
    verifyLiveServer("http://localhost:2000", "test-secret", () =>
      Promise.resolve(new Response("ordinary server"))
    ),
    NOT_LIVE
  );
});

test("zero comparable reads are unverifiable and never permit cause grading", () => {
  for (const reads of [
    [],
    [
      {
        recorded: readResult({ available: false }),
        reread: readResult({ available: true, balance: 1 }),
        tool: "widget_billing_summary",
      },
    ],
  ]) {
    const result = driftVerdict(reads);
    assert.equal(result.compared, 0);
    assert.equal(result.verdict, "unverifiable");
    assert.equal(result.causeGradeAllowed, false);
  }
});

test("failed and unavailable reads cannot masquerade as customer drift or steady state", () => {
  const output = {
    inbox: { active: true },
    observedAt: "2026-10-01T00:00:00Z",
  };
  const steady = {
    recorded: readResult(output),
    reread: readResult({
      inbox: { active: true },
      observedAt: "2026-10-09T00:00:00Z",
    }),
    tool: "widget_inbox_health",
  };
  assert.equal(driftVerdict([steady]).verdict, "steady");
  for (const failure of [
    { error: "timeout" },
    { available: false },
    { status: "unavailable" },
    { ok: false },
  ]) {
    const failed = { ...steady, reread: readResult(failure) };
    assert.deepEqual(driftVerdict([steady, failed]), {
      causeGradeAllowed: false,
      changed: [],
      compared: 1,
      partial: [],
      unverifiable: [steady.tool],
      verdict: "unverifiable",
    });
    assert.equal(
      driftVerdict([{ ...failed, recorded: readResult(failure) }]).compared,
      0
    );
  }
  assert.equal(readResult(output, "error").status, "unverifiable");
  assert.equal(readResult({ status: "denied" }).status, "unverifiable");
  assert.equal(
    readResult({
      available: true,
      failures: [{ error: "job failure evidence", status: "failed" }],
    }).status,
    "ok"
  );
  const moved = { ...steady, reread: readResult({ inbox: { active: false } }) };
  assert.equal(
    driftVerdict([moved, { ...steady, reread: { status: "unverifiable" } }])
      .verdict,
    "state moved"
  );
  assert.equal(driftVerdict([moved]).causeGradeAllowed, false);
});

test("a sub-object marked unavailable on purpose is left out, and the rest is still compared", () => {
  // An outreach listing marks each campaign's provider check unavailable until one is selected.
  const listing = (sending: boolean) => ({
    campaigns: [
      {
        live: { available: false, reason: "Select this campaignId." },
        sending,
      },
    ],
  });
  const read = (recorded: unknown, reread: unknown) => ({
    recorded: readResult(recorded),
    reread: readResult(reread),
    tool: "widget_outreach_health",
  });
  // The dropped part may be a nested source that failed, so equality is not steady.
  assert.deepEqual(driftVerdict([read(listing(true), listing(true))]), {
    causeGradeAllowed: false,
    changed: [],
    compared: 1,
    partial: ["widget_outreach_health"],
    unverifiable: [],
    verdict: "unverifiable",
  });
  assert.equal(
    driftVerdict([read(listing(true), listing(false))]).verdict,
    "state moved"
  );
  // Readable when recorded, unavailable on the re-read: not movement.
  const oneSided = driftVerdict([
    read(
      { campaigns: [{ live: { status: "active" }, sending: true }] },
      listing(true)
    ),
  ]);
  assert.equal(oneSided.verdict, "unverifiable");
  assert.deepEqual(oneSided.changed, []);
});

test("live tool boundary enforces historical date windows and preserves explicit windows", async (t) => {
  const previous = process.env.WIDGET_LIVE;
  process.env.WIDGET_LIVE = "1";
  t.after(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "WIDGET_LIVE");
    } else {
      process.env.WIDGET_LIVE = previous;
    }
  });
  const scope = {
    ...fixture,
    liveAsOf: "2026-10-09T15:00:00Z",
    source: "inbox" as const,
  };
  const auth = widgetAuth(scope);
  const ctx = {
    abortSignal: AbortSignal.timeout(5000),
    getToken: () => Promise.resolve({ token: "test-token" }),
    session: { auth: { current: auth, initiator: auth } },
  } as never;
  for (const [key, value] of Object.entries({
    EXECUTOR_MCP_CONNECTOR_SUPPORT: "executor.test/widget",
    EXECUTOR_OPERATION_BINDINGS: JSON.stringify({
      "planetscale.readQuery": {
        path: "planetscale-org.planetscale_execute_read_query",
      },
    }),
  })) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (old === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = old;
      }
    });
  }
  const queries: string[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, _path: string, input: { query?: string }) => {
      const query = input.query ?? "";
      queries.push(query);
      let rows: unknown[] = [];
      if (query.includes('as "observedAt"')) {
        rows = [
          {
            authorized: false,
            inboxes: null,
            observedAt: "2026-10-09T00:00:00Z",
            records: [],
          },
        ];
      } else if (query.includes(" as authorized")) {
        rows = [{ authorized: true }];
      } else if (query.includes("from organization o")) {
        rows = [{ id: fixture.organizationId }];
      }
      return Promise.resolve({
        data: {
          content: [
            { text: JSON.stringify({ rows, success: true }), type: "text" },
          ],
        },
        ok: true,
      });
    }
  );
  const resolveTool = (
    definition:
      | typeof billingDefinition
      | typeof outreachDefinition
      | typeof ticketDefinition
  ) => {
    const events = definition.events as Record<
      string,
      (event: unknown, context: unknown) => unknown
    >;
    return events["step.started"]({}, ctx) as {
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    };
  };
  const billing = {
    execute: (input: unknown, _ctx: unknown) =>
      Promise.resolve(
        liveToolInput("widget_billing_summary", input, scope.liveAsOf)
      ),
  };
  assert.deepEqual(await billing.execute({}, ctx), {
    creditWindow: {
      from: "2026-10-09T00:00:00.000Z",
      to: "2026-10-10T00:00:00.000Z",
    },
  });
  const explicit = {
    creditWindow: { from: "2026-09-01T00:00:00Z", to: "2026-09-02T00:00:00Z" },
  };
  assert.deepEqual(await billing.execute(explicit, ctx), explicit);
  const outreach = {
    execute: (input: unknown, _ctx: unknown) =>
      Promise.resolve(
        liveToolInput("widget_outreach_health", input, scope.liveAsOf)
      ),
  };
  assert.deepEqual(
    await outreach.execute({ campaignId: fixture.organizationId }, ctx),
    {
      campaignId: fixture.organizationId,
      endDate: "2026-10-09",
      startDate: "2026-10-03",
    }
  );
  const window = {
    campaignId: fixture.organizationId,
    endDate: "2026-09-07",
    startDate: "2026-09-01",
  };
  assert.deepEqual(await outreach.execute(window, ctx), window);
  assert.deepEqual(await outreach.execute({}, ctx), {
    endDate: "2026-10-09",
    startDate: "2026-10-03",
  });
  await resolveTool(billingDefinition).execute({}, ctx);
  assert.equal(
    queries.some(
      (query) =>
        query.includes("created_at >= '2026-10-09T00:00:00.000Z'") &&
        query.includes("created_at < '2026-10-10T00:00:00.000Z'")
    ),
    true
  );
  await resolveTool(outreachDefinition).execute(
    { campaignId: fixture.organizationId },
    ctx
  );
  assert.equal(
    queries.some(
      (query) =>
        query.includes("'2026-10-03'::date") &&
        query.includes("'2026-10-09'::date")
    ),
    true
  );
  assert.equal(hasMovingWindow("widget_outreach_health", {}), true);
  assert.equal(hasMovingWindow("widget_billing_summary", explicit), false);
  assert.equal(hasMovingWindow("widget_outreach_health", window), false);
  assert.deepEqual(
    await resolveTool(ticketDefinition).execute(
      { summary: "s", title: "t" },
      ctx
    ),
    LIVE_TICKET
  );
  // Simulated, so the composer's "passed to the team" path runs; nothing is filed.
  assert.equal(LIVE_TICKET.simulated, true);
  assert.deepEqual(
    filedTicketResult({
      kind: "tool-result",
      output: LIVE_TICKET,
      toolName: "widget_file_ticket",
    }),
    { id: "ENG-0", url: LIVE_TICKET.url }
  );
});

test("picks sentences that say something could not be confirmed", () => {
  assert.deepEqual(
    gapSentences(
      "Your inbox is active. I can’t confirm the send count. No send activity was recorded for that week. Thanks!"
    ),
    [
      "I can’t confirm the send count.",
      "No send activity was recorded for that week.",
    ]
  );
});

test("a live re-run keeps the recorded screen recording so its reader is offered", () => {
  const sentAt = "2026-10-07T12:00:00.000Z";
  const scope = liveContext({
    conversationId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
    organizationId: fixture.organizationId,
    staff: true,
    userToken: Buffer.from(
      JSON.stringify({ scope: { ...fixture, recordingId: "jam-abc" }, sentAt })
    ).toString("base64url"),
  });
  assert.equal(scope.recordingId, "jam-abc");
  assert.equal(scope.source, "inbox");
  assert.equal(scope.liveAsOf, sentAt);
});

test("first customer reply ignores progress and empty messages", () => {
  const progress = {
    message: null,
    progress: { checks: [], stage: "investigating" },
  };
  assert.equal(replyElapsed(progress, 1000, 4000), null);
  assert.equal(replyElapsed({ message: " " }, 1000, 4000), null);
  assert.equal(
    replyElapsed({ message: "Here is the answer." }, 1000, 61_000),
    60_000
  );
});

// ENG-20609: a switched area's endpoint read compares by section, and a
// section the endpoint lists in unavailable leaves both sides.
test("an endpoint read compares its sections, and an unavailable section is partial, not movement", () => {
  const body = (sections: object, unavailable: object[] = []) =>
    readResult({ sections, status: "ok", unavailable });
  const recorded = body({ orders: [{ status: "paid" }], refunds: [] });
  const steady = {
    recorded,
    reread: body({ orders: [{ status: "paid" }], refunds: [] }),
    tool: "widget_orders",
  };
  assert.equal(driftVerdict([steady]).verdict, "steady");
  const moved = {
    ...steady,
    reread: body({ orders: [{ status: "refunded" }], refunds: [] }),
  };
  assert.deepEqual(driftVerdict([moved]).changed, ["widget_orders"]);
  // The refunds section timed out on the re-read: not movement, but not steady either.
  const timedOut = {
    ...steady,
    reread: body({ orders: [{ status: "paid" }] }, [
      { reason: "timeout", section: "refunds" },
    ]),
  };
  const verdict = driftVerdict([timedOut]);
  assert.deepEqual(verdict.changed, []);
  assert.deepEqual(verdict.partial, ["widget_orders"]);
  assert.equal(verdict.verdict, "unverifiable");
});

test("billing endpoint reads always cover a moving window, and campaigns ones do without both dates", () => {
  assert.equal(hasMovingWindow("widget_billing", {}), true);
  assert.equal(hasMovingWindow("widget_billing", { creditWindow: 30 }), true);
  assert.equal(hasMovingWindow("widget_campaigns", {}), true);
  assert.equal(
    hasMovingWindow("widget_campaigns", { startDate: "2026-11-01" }),
    true
  );
  assert.equal(
    hasMovingWindow("widget_campaigns", {
      endDate: "2026-11-07",
      startDate: "2026-11-01",
    }),
    false
  );
  // An endpoint tool's input is never rewritten: only the hand-written tools pin.
  assert.deepEqual(
    pinLiveInput(
      "widget_billing",
      { creditWindow: 30 },
      "2026-11-01T10:00:00.000Z"
    ),
    { creditWindow: 30 }
  );
});

test("an endpoint's whole-read refusal is unverifiable, never steady or movement", () => {
  for (const status of ["feature_off", "invalid_input"]) {
    const refused = readResult({ status });
    const ok = readResult({
      sections: { orders: [] },
      status: "ok",
      unavailable: [],
    });
    for (const [recorded, reread] of [
      [refused, refused],
      [ok, refused],
    ]) {
      const verdict = driftVerdict([
        { recorded, reread, tool: "widget_orders" },
      ]);
      assert.equal(verdict.verdict, "unverifiable", status);
      assert.deepEqual(verdict.unverifiable, ["widget_orders"]);
    }
  }
});

test("the re-run's date note names each dated tool the rollout offers", () => {
  assert.deepEqual(datedTools(new Set(["billing", "campaigns"])), {
    widget_billing_summary: "creditWindow",
    widget_outreach_health: "startDate and endDate",
  });
  assert.deepEqual(datedTools(new Set()), {
    widget_campaigns: "startDate and endDate",
  });
});
