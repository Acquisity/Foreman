import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ProviderContext } from "./executor/dispatch.js";
import { executorTransport } from "./executor/transport.js";
import { verifiedWidgetContext } from "./widget.fixture.js";
import {
  type BugReportTurn,
  EVIDENCE_SOURCES,
  gatherEvidence,
} from "./widget-bug-evidence.js";
import { widgetAuth } from "./widget-scope.js";

const RUN_ID = "44444444-4444-4444-8444-444444444444";

const turn: BugReportTurn = {
  history: [
    { role: "customer", text: "I found a bug" },
    { role: "assistant", text: "Sorry about that. What went wrong?" },
  ],
  messageId: "55555555-5555-4555-8555-555555555555",
  question: "My campaign stays on Scheduling and never sends.",
};

test("each evidence source reports items, nothing found, or not checked when it throws", async () => {
  const result = await gatherEvidence(verifiedWidgetContext, turn, RUN_ID, {
    Axiom: () => Promise.resolve({ status: "empty" }),
    Browser: () => Promise.resolve({ status: "not_sent" }),
    Inngest: () => Promise.reject(new Error("Inngest is down")),
    Jam: () => Promise.reject(new Error("recording unreadable")),
    PostHog: () =>
      Promise.resolve({ reason: "PostHog is not set up", status: "unchecked" }),
    Sentry: () =>
      Promise.resolve({
        items: [
          { text: "TypeError", url: "https://acquisity.sentry.io/issues/1/" },
        ],
        status: "found",
      }),
  });
  assert.deepEqual(result, {
    Axiom: { status: "empty" },
    Browser: { status: "not_sent" },
    Inngest: { reason: "the lookup failed", status: "unchecked" },
    Jam: { reason: "the lookup failed", status: "unchecked" },
    PostHog: { reason: "PostHog is not set up", status: "unchecked" },
    Sentry: {
      items: [
        { text: "TypeError", url: "https://acquisity.sentry.io/issues/1/" },
      ],
      status: "found",
    },
  });
});

const withEnv = (t: TestContext, key: string, value: string | undefined) => {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
};

const providerCtx = (): ProviderContext => {
  const auth = widgetAuth(verifiedWidgetContext, RUN_ID);
  return {
    abortSignal: new AbortController().signal,
    getToken: () => Promise.resolve({ token: "executor-token" }),
    session: { auth: { current: auth, initiator: auth } },
  } as unknown as ProviderContext;
};

const answer = (t: TestContext, data: unknown) => {
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const paths: string[] = [];
  t.mock.method(executorTransport, "call", (_wire: unknown, path: string) => {
    paths.push(path);
    return Promise.resolve({ data, http: { status: 200 }, ok: true });
  });
  return paths;
};

test("Sentry searches by the workspace tag, which its search keeps, not a bare key it drops", async (t) => {
  withEnv(t, "WIDGET_SENTRY_ORG_SLUG", "acquisity-ai");
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const inputs: Record<string, unknown>[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, _path: string, input: Record<string, unknown>) => {
      inputs.push(input);
      return Promise.resolve({
        data: { content: [{ text: "No issues found.", type: "text" }] },
        http: { status: 200 },
        ok: true,
      });
    }
  );
  await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn);
  assert.deepEqual(inputs, [
    {
      limit: 8,
      organizationSlug: "acquisity-ai",
      query: `tags[organizationId]:${verifiedWidgetContext.organizationId} lastSeen:-24h`,
      sort: "date",
    },
  ]);
});

test("Sentry lists each issue by its title with its link, and nothing found when there is none", async (t) => {
  withEnv(t, "WIDGET_SENTRY_ORG_SLUG", "acquisity");
  const paths = answer(t, {
    content: [
      {
        text: '# Search Results for "tags[organizationId]:x"\n\n**View these results in Sentry**:\nhttps://acquisity-ai.sentry.io/issues/?query=x\n\nFound **1** issues:\n\n## 1. [ACQUISITY-67W](https://acquisity-ai.sentry.io/issues/ACQUISITY-67W)\n\n**TypeError: schedule is undefined**\n\n- **Status**: unresolved\n- **Culprit**: `POST /api/inngest`\n',
        type: "text",
      },
    ],
  });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: "ACQUISITY-67W: TypeError: schedule is undefined",
          url: "https://acquisity-ai.sentry.io/issues/ACQUISITY-67W",
        },
      ],
      status: "found",
    }
  );
  assert.deepEqual(paths, ["sentry-foreman.search_issues"]);
  t.mock.restoreAll();
  answer(t, { content: [{ text: "No issues found.", type: "text" }] });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    { status: "empty" }
  );
});

test("Sentry reads v2's structured issues when the text content is empty", async (t) => {
  withEnv(t, "WIDGET_SENTRY_ORG_SLUG", "acquisity");
  answer(t, {
    content: [],
    structuredContent: {
      issues: [
        {
          shortId: "ACQUISITY-67W",
          title: "TypeError: schedule is undefined",
          url: "https://acquisity-ai.sentry.io/issues/ACQUISITY-67W",
        },
        { shortId: "X-1", title: "elsewhere", url: "https://example.com/x" },
      ],
      query: "x",
    },
  });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: "ACQUISITY-67W: TypeError: schedule is undefined",
          url: "https://acquisity-ai.sentry.io/issues/ACQUISITY-67W",
        },
      ],
      status: "found",
    }
  );
  t.mock.restoreAll();
  answer(t, {
    content: [],
    structuredContent: {
      issues: [
        {
          shortId: "X".repeat(200),
          url: "https://acquisity-ai.sentry.io/issues/X",
        },
        {
          shortId: "ACQUISITY-1",
          url: "https://acquisity-ai.sentry.io/issues/ACQUISITY-1",
        },
      ],
    },
  });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: "ACQUISITY-1",
          url: "https://acquisity-ai.sentry.io/issues/ACQUISITY-1",
        },
      ],
      status: "found",
    }
  );
  t.mock.restoreAll();
  answer(t, { content: [], structuredContent: { results: "changed" } });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    {
      reason: "Sentry returned an unexpected result shape",
      status: "unchecked",
    }
  );
  t.mock.restoreAll();
  answer(t, { content: [], structuredContent: { issues: [] } });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    { status: "empty" }
  );
});

test("Sentry is not checked when its organization is not configured", async (t) => {
  withEnv(t, "WIDGET_SENTRY_ORG_SLUG", undefined);
  assert.deepEqual(
    await EVIDENCE_SOURCES.Sentry(providerCtx(), verifiedWidgetContext, turn),
    { reason: "WIDGET_SENTRY_ORG_SLUG is not set", status: "unchecked" }
  );
});

/**
 * Axiom's MCP answers every tool in CSV text under a `# name.csv` line
 * (measured on listDatasets, getDatasetFields and getSavedQueries, 20 Nov
 * 2026). The message is a real one from the app logs: quoted, with commas
 * and doubled quotes.
 */
const axiomCsv = (body: string) => ({
  content: [{ text: `# results.csv\n\n${body}`, type: "text" }],
});
const FEATUREBASE =
  'FeatureBase identify error: {"name":"Error","message":"Identify functionality is available starting from the Growth plan.","stack":"@https://do.featurebase.app/js/sdk.js:489:105234"}';
const UNRECOGNIZED_AXIOM = /Unrecognized Axiom response/;

test("Axiom reads this workspace's and user's errors in the day before the report", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const apls: string[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, _path: string, input: { apl: string }) => {
      apls.push(input.apl);
      return Promise.resolve({
        data: axiomCsv("No results found."),
        http: { status: 200 },
        ok: true,
      });
    }
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, {
      ...turn,
      reportedAt: "2026-11-20T10:22:00.000Z",
    }),
    { status: "empty" }
  );
  assert.equal(
    apls[0],
    [
      "['acquisity']",
      "| where _time >= datetime('2026-11-19T10:22:00.000Z') and _time <= datetime('2026-11-20T10:22:00.000Z')",
      `| where tostring(['fields']['organizationId']) == '${verifiedWidgetContext.organizationId}' or (isempty(tostring(['fields']['organizationId'])) and tostring(['fields']['userId']) == '${verifiedWidgetContext.userId}')`,
      "| where tostring(['level']) in ('error', 'fatal')",
      "| summarize count = count(), lastSeen = max(_time) by message",
      "| sort by lastSeen desc",
      "| extend lastSeen = tostring(todatetime(lastSeen))",
      "| limit 8",
    ].join("\n")
  );
});

test("Axiom parses its CSV answer, quoted messages included", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  answer(
    t,
    axiomCsv(
      [
        "message,count,lastSeen",
        `"${FEATUREBASE.replaceAll('"', '""')}",4,2026-11-20T10:21:19.558000128Z`,
        '"Send Email - Failed to send\nretrying",1,2026-11-19T12:30:17.070000128Z',
      ].join("\n")
    )
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: `${FEATUREBASE} (4 times, last 20 November 2026 at 10:21 UTC)`,
        },
        {
          text: "Send Email - Failed to send\nretrying (1 times, last 19 November 2026 at 12:30 UTC)",
        },
      ],
      status: "found",
    }
  );
});

test("Axiom still reads structured or JSON rows, the shape it read before", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  answer(t, {
    structuredContent: {
      matches: [
        {
          count: 3,
          lastSeen: "2026-11-04T10:00:00Z",
          message: "Campaign schedule failed",
        },
      ],
    },
  });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: "Campaign schedule failed (3 times, last 4 November 2026 at 10:00 UTC)",
        },
      ],
      status: "found",
    }
  );
  t.mock.restoreAll();
  answer(t, { content: [{ text: '{"matches": []}', type: "text" }] });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    { status: "empty" }
  );
});

test("a quoted Axiom message holding a heading-shaped line stays in its row", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  answer(
    t,
    axiomCsv(
      [
        "message,count,lastSeen",
        '"Import failed\n# rows.csv\nline 2",2,2026-11-20T10:21:19.558000128Z',
        "Send Email - Failed to send,1,2026-11-19T12:30:17.070000128Z",
      ].join("\n")
    )
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    {
      items: [
        {
          text: "Import failed\n# rows.csv\nline 2 (2 times, last 20 November 2026 at 10:21 UTC)",
        },
        {
          text: "Send Email - Failed to send (1 times, last 19 November 2026 at 12:30 UTC)",
        },
      ],
      status: "found",
    }
  );
});

test("an Axiom answer without the query's table, with an open quote, or an error, is reported as not checked", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  answer(t, axiomCsv('message,count,lastSeen\n"never closed,1,x'));
  await assert.rejects(
    EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    UNRECOGNIZED_AXIOM
  );
  t.mock.restoreAll();
  answer(t, axiomCsv("name,type\n_time,datetime"));
  await assert.rejects(
    EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn),
    UNRECOGNIZED_AXIOM
  );
  t.mock.restoreAll();
  answer(t, {
    content: [{ text: "Query failed: syntax error", type: "text" }],
    isError: true,
  });
  await assert.rejects(
    EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn)
  );
});

/** inngest.list_runs as it answered live on 20 Nov 2026: runs in structuredContent.data, and no data at all when nothing matched. */
const inngestPage = (
  runs: { endedAt: string; id: string; name: string }[],
  cursor?: string
) => ({
  content: [],
  structuredContent: {
    ...(runs.length
      ? {
          data: runs.map(({ endedAt, id, name }) => ({
            app: { id: "ai-clients" },
            endedAt,
            function: { id: `ai-clients.${name}`, name },
            id,
            status: "FAILED",
          })),
        }
      : {}),
    metadata: { fetchedAt: "2026-11-20T23:20:52.014308852Z" },
    page: { ...(cursor ? { cursor, hasMore: true } : {}), limit: 8 },
  },
});

test("Inngest lists only this workspace's failed runs in the hour before the report, following the page cursor", async (t) => {
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const calls: { input: Record<string, unknown>; path: string }[] = [];
  const pages = [
    inngestPage([], "page-2"),
    inngestPage([
      {
        endedAt: "2026-11-11T18:40:37.457Z",
        id: "01JTESTRUN0000000000000001",
        name: "Campaign email daily results sync (per campaign)",
      },
    ]),
  ];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      calls.push({ input, path });
      return Promise.resolve({
        data: pages.shift(),
        http: { status: 200 },
        ok: true,
      });
    }
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.Inngest(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    {
      items: [
        {
          text: "Campaign email daily results sync (per campaign) failed at 18:40:37 UTC",
          url: "https://app.inngest.com/env/production/runs/01JTESTRUN0000000000000001",
        },
      ],
      status: "found",
    }
  );
  const filter = {
    env: "production",
    from: "2026-11-11T17:55:00.000Z",
    limit: 8,
    query: `event.data.organizationId == "${verifiedWidgetContext.organizationId}"`,
    status: ["FAILED"],
    until: "2026-11-11T18:55:00.000Z",
  };
  assert.deepEqual(calls, [
    { input: filter, path: "inngest.list_runs" },
    { input: { ...filter, cursor: "page-2" }, path: "inngest.list_runs" },
  ]);
});

test("Inngest with no failed runs for the workspace is nothing found, and an error answer is not checked", async (t) => {
  answer(t, inngestPage([]));
  assert.deepEqual(
    await EVIDENCE_SOURCES.Inngest(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    { status: "empty" }
  );
  t.mock.restoreAll();
  answer(t, {
    content: [{ text: "REST v2 returned HTTP 400", type: "text" }],
    isError: true,
    structuredContent: { errors: [{ code: "missing_field" }] },
  });
  await assert.rejects(
    EVIDENCE_SOURCES.Inngest(reportedCtx(), verifiedWidgetContext, reportedTurn)
  );
});

/** The shape posthog-widget.execute-sql returned live on Executor v2: one text block, an optional warnings block, then a pipe table. */
const posthogTable = (rows: string[]) => ({
  content: [
    {
      text: `<taxonomy_warnings>\nYour query references names that don't exist in this project's taxonomy.\n- Event '$exception' was not found in this project taxonomy.\n</taxonomy_warnings>\n\n${["timestamp|event|errorCode|sessionId|recorded|$pathname", ...rows].join("\n")}`,
      type: "text",
    },
  ],
});
const UNRECOGNIZED_POSTHOG = /Unrecognized PostHog response/;
const reportedTurn = { ...turn, reportedAt: "2026-11-11T18:55:00.000Z" };
const reportedCtx = (): ProviderContext => {
  const auth = widgetAuth(
    { ...verifiedWidgetContext, bugReportedAt: reportedTurn.reportedAt },
    RUN_ID
  );
  return {
    abortSignal: new AbortController().signal,
    getToken: () => Promise.resolve({ token: "executor-token" }),
    session: { auth: { current: auth, initiator: auth } },
  } as unknown as ProviderContext;
};

const capture = {
  browser: "Chrome 131",
  consoleErrors: [],
  failedRequests: [],
  page: "/dashboard/acme",
  replayId: null,
  screen: "1440x900",
  sentryEventIds: [],
};

test("browser evidence keeps the newest failed requests beside a full console, and drops a request line that is not method, path, status and time", async () => {
  const result = await EVIDENCE_SOURCES.Browser(
    {} as ProviderContext,
    verifiedWidgetContext,
    {
      ...turn,
      browser: {
        ...capture,
        consoleErrors: Array.from(
          { length: 30 },
          (_, i) => `10:20:${String(i).padStart(2, "0")} error Boom ${i}`
        ),
        failedRequests: [
          "10:20:59 POST /api/trpc/campaigns.launch 500 812ms",
          "10:21:00 GET /api/x?token=secret 500 3ms",
          '10:21:01 {"authorization":"x"}',
        ],
        sentryEventIds: ["0123456789abcdef0123456789abcdef"],
      },
    }
  );
  assert.deepEqual(result, {
    items: [
      { text: "Sentry error events: 0123456789abcdef0123456789abcdef" },
      {
        text: "Request failed: 10:20:59 POST /api/trpc/campaigns.launch 500 812ms",
      },
      { text: "Console: 10:20:26 error Boom 26" },
      { text: "Console: 10:20:27 error Boom 27" },
      { text: "Console: 10:20:28 error Boom 28" },
      { text: "Console: 10:20:29 error Boom 29" },
    ],
    status: "found",
  });
});

test("an Inngest answer without a page, or a scan still unfinished after three pages, is reported as not checked", async (t) => {
  answer(t, { content: [], structuredContent: {} });
  await assert.rejects(
    EVIDENCE_SOURCES.Inngest(reportedCtx(), verifiedWidgetContext, reportedTurn)
  );
  t.mock.restoreAll();
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  let calls = 0;
  t.mock.method(executorTransport, "call", () => {
    calls += 1;
    return Promise.resolve({
      data: inngestPage([], `page-${calls + 1}`),
      http: { status: 200 },
      ok: true,
    });
  });
  assert.deepEqual(
    await EVIDENCE_SOURCES.Inngest(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    {
      reason: "Inngest still had runs to scan after 3 pages",
      status: "unchecked",
    }
  );
  assert.equal(calls, 3);
});

test("PostHog reads this user's activity in the 30 minutes before the report", async (t) => {
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const calls: { input: Record<string, unknown>; path: string }[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      calls.push({ input, path });
      return Promise.resolve({
        data: posthogTable([]),
        http: { status: 200 },
        ok: true,
      });
    }
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.PostHog(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    { status: "empty" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "posthog-widget.execute-sql");
  assert.deepEqual(Object.keys(calls[0]?.input ?? {}), ["query"]);
  const query = String(calls[0]?.input.query);
  assert.ok(query.includes(verifiedWidgetContext.userId));
  assert.ok(
    query.includes(`$group_0 = '${verifiedWidgetContext.organizationId}'`)
  );
  assert.ok(query.includes("2026-11-11T18:25:00.000Z"));
  assert.ok(query.includes("2026-11-11T18:55:00.000Z"));
});

const SESSION = "01900000-0000-7000-8000-000000000001";

test("PostHog links the recording of a recorded session, and lists page views and error toasts by path", async (t) => {
  withEnv(t, "WIDGET_POSTHOG_PROJECT_ID", "12345");
  answer(
    t,
    posthogTable([
      `2026-11-11T18:53:07.841000Z|$pageview|(null)|${SESSION}|1|/dashboard`,
      `2026-11-11T18:52:50.802000Z|crm.error_toast_shown|CAMPAIGN_SEND_FAILED|${SESSION}|1|/campaigns/${"x".repeat(400)}`,
    ])
  );
  const result = await EVIDENCE_SOURCES.PostHog(
    reportedCtx(),
    verifiedWidgetContext,
    reportedTurn
  );
  assert.equal(result.status, "found");
  const items = result.status === "found" ? result.items : [];
  const recording = {
    text: "PostHog recording of this session",
    url: `https://us.posthog.com/project/12345/replay/${SESSION}`,
  };
  // The link goes under How to see it once, so the activity list does not repeat it.
  assert.deepEqual(result.status === "found" && result.recording, recording);
  assert.equal(result.status === "found" && result.page, "/dashboard");
  assert.deepEqual(items[0], { text: "Viewed /dashboard at 18:53:07 UTC" });
  assert.ok(
    items[1]?.text.startsWith("Error toast CAMPAIGN_SEND_FAILED on /campaigns/")
  );
  assert.equal(items[1]?.text.length, 300);
  assert.ok(!items.some(({ url }) => url));
  assert.ok(!items.some(({ text }) => text.includes("person")));
});

test("PostHog links only the session at the report time, not an older recorded one", async (t) => {
  withEnv(t, "WIDGET_POSTHOG_PROJECT_ID", "12345");
  answer(
    t,
    posthogTable([
      "2026-11-11T18:54:10.000000Z|$pageview|(null)|01a1f8aa-0000-7000-8000-000000000001|0|/dashboard/acme/campaigns",
      `2026-11-11T18:40:00.000000Z|$pageview|(null)|${SESSION}|1|/dashboard/acme`,
    ])
  );
  const result = await EVIDENCE_SOURCES.PostHog(
    reportedCtx(),
    verifiedWidgetContext,
    reportedTurn
  );
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.recording, undefined);
  assert.deepEqual(result.status === "found" && result.items[0], {
    text: "No PostHog recording (we only record some sessions)",
  });
  assert.equal(
    result.status === "found" && result.page,
    "/dashboard/acme/campaigns"
  );
});

test("a PostHog path that is not a plain pathname is never used as the page", async (t) => {
  answer(
    t,
    posthogTable([
      `2026-11-11T18:54:10.000000Z|$pageview|(null)|${SESSION}|0|/x ${"y".repeat(400)}`,
    ])
  );
  const result = await EVIDENCE_SOURCES.PostHog(
    reportedCtx(),
    verifiedWidgetContext,
    reportedTurn
  );
  assert.equal(result.status === "found" && result.page, undefined);
});

test("PostHog says there is no recording when the session was not recorded, and links no person", async (t) => {
  withEnv(t, "WIDGET_POSTHOG_PROJECT_ID", "12345");
  answer(
    t,
    posthogTable([
      `2026-11-20T10:21:15.992000Z|$pageview|(null)|${SESSION}|0|/auth/oauth/workspace`,
    ])
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.PostHog(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    {
      items: [
        { text: "No PostHog recording (we only record some sessions)" },
        { text: "Viewed /auth/oauth/workspace at 10:21:15 UTC" },
      ],
      page: "/auth/oauth/workspace",
      status: "found",
    }
  );
});

test("PostHog names a recording without a link when its project is not configured", async (t) => {
  withEnv(t, "WIDGET_POSTHOG_PROJECT_ID", undefined);
  answer(
    t,
    posthogTable([
      `2026-11-11T18:53:07.841000Z|$pageview|(null)|${SESSION}|1|/dashboard`,
    ])
  );
  assert.deepEqual(
    await EVIDENCE_SOURCES.PostHog(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    {
      items: [
        { text: "PostHog recorded this session" },
        { text: "Viewed /dashboard at 18:53:07 UTC" },
      ],
      page: "/dashboard",
      status: "found",
    }
  );
});

test("an unrecognized PostHog response is reported as not checked", async (t) => {
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  t.mock.method(executorTransport, "call", () =>
    Promise.resolve({
      data: { content: [{ text: '{"results": []}', type: "text" }] },
      http: { status: 200 },
      ok: true,
    })
  );
  await assert.rejects(
    EVIDENCE_SOURCES.PostHog(
      reportedCtx(),
      verifiedWidgetContext,
      reportedTurn
    ),
    UNRECOGNIZED_POSTHOG
  );
  const result = await gatherEvidence(
    verifiedWidgetContext,
    reportedTurn,
    RUN_ID,
    {
      ...EVIDENCE_SOURCES,
      Axiom: () => Promise.resolve({ status: "empty" }),
      Inngest: () => Promise.resolve({ status: "empty" }),
      Jam: () => Promise.resolve({ status: "empty" }),
      Sentry: () => Promise.resolve({ status: "empty" }),
    }
  );
  assert.deepEqual(result.PostHog, {
    reason: "the lookup failed",
    status: "unchecked",
  });
});

for (const [name, row] of [
  ["garbage", "garbage|garbage"],
  ["one-cell", "garbage"],
  [
    "unknown event",
    "2026-11-11T18:53:07.841000Z|unknown|(null)|(null)|0|/dashboard",
  ],
  ["invalid timestamp", "garbage|$pageview|(null)|(null)|0|/dashboard"],
  [
    "unknown recorded flag",
    "2026-11-11T18:53:07.841000Z|$pageview|(null)|(null)|yes|/dashboard",
  ],
]) {
  test(`a PostHog ${name} row is reported as not checked`, async (t) => {
    answer(t, posthogTable([row]));
    await assert.rejects(
      EVIDENCE_SOURCES.PostHog(
        reportedCtx(),
        verifiedWidgetContext,
        reportedTurn
      ),
      UNRECOGNIZED_POSTHOG
    );
    const result = await gatherEvidence(
      verifiedWidgetContext,
      reportedTurn,
      RUN_ID,
      {
        ...EVIDENCE_SOURCES,
        Axiom: () => Promise.resolve({ status: "empty" }),
        Inngest: () => Promise.resolve({ status: "empty" }),
        Jam: () => Promise.resolve({ status: "empty" }),
        Sentry: () => Promise.resolve({ status: "empty" }),
      }
    );
    assert.deepEqual(result.PostHog, {
      reason: "the lookup failed",
      status: "unchecked",
    });
  });
}
