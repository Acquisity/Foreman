import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ProviderContext } from "./executor/dispatch.js";
import { executorTransport } from "./executor/transport.js";
import { verifiedWidgetContext } from "./widget.fixture.js";
import {
  additionCommentId,
  addToBugReport,
  BUG_REPORT_ADDED,
  BUG_REPORT_LOGGED,
  type BugReportTurn,
  bugReportTicket,
  EVIDENCE_SOURCES,
  type Evidence,
  type EvidenceSource,
  fallbackDraft,
  fileBugReport,
  gatherEvidence,
} from "./widget-bug-report.js";
import {
  receiveWidgetMessage,
  type WidgetDependencies,
} from "./widget-investigation.js";
import type { WidgetOutcome, WidgetRun } from "./widget-run-store.js";
import { type WidgetContext, widgetAuth } from "./widget-scope.js";
import { fileTicketFor } from "./widget-ticket.js";

const SENTRY_SECTION =
  /### Sentry\n- \[TypeError: cannot read schedule\]\(https:\/\/acquisity\.sentry\.io\/issues\/123\/\)/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SERVICE_SECRET = "s".repeat(40);
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const TICKET = {
  identifier: "ENG-900",
  url: "https://linear.app/acquisity/issue/ENG-900/campaign-never-sends",
};

function enabled(t: TestContext) {
  for (const [key, value] of [
    ["SUPPORT_CHAT_ENABLED", "true"],
    ["FOREMAN_DIAGNOSTICS_SECRET", SERVICE_SECRET],
  ] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
  }
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
}

const turn: BugReportTurn = {
  history: [
    { role: "customer", text: "I found a bug" },
    { role: "assistant", text: "Sorry about that. What went wrong?" },
  ],
  messageId: MESSAGE_ID,
  question: "My campaign stays on Scheduling and never sends.",
};

const evidence: Record<EvidenceSource, Evidence> = {
  Axiom: { status: "empty" },
  Inngest: { reason: "the lookup failed", status: "unchecked" },
  Jam: { reason: "the customer sent no recording", status: "unchecked" },
  PostHog: {
    reason: "PostHog is not in the support widget toolkit",
    status: "unchecked",
  },
  Sentry: {
    items: [
      {
        text: "TypeError: cannot read schedule",
        url: "https://acquisity.sentry.io/issues/123/",
      },
    ],
    status: "found",
  },
};

/** Files through the real one-ticket-per-conversation path, with Linear faked. */
const linear = (existing: boolean) => {
  const calls = { creates: [] as { bug?: boolean; report: string }[] };
  const file: typeof fileTicketFor = (scope, input, signal, runId) =>
    fileTicketFor(scope, input, signal, runId, {
      create: (_ctx, created) => {
        calls.creates.push(created);
        return Promise.resolve({
          data: {
            id: "ENG-901",
            url: "https://linear.app/acquisity/issue/ENG-901/new",
          },
          ok: true as const,
        });
      },
      readReceipt: () => Promise.resolve(null),
      refund: () => assert.fail("a bug report is never a refund"),
      saveReceipt: () => Promise.resolve(),
      search: () =>
        Promise.resolve({
          createdAfter: null,
          issues: existing
            ? [
                {
                  assignee: "Aaron Fraga",
                  createdAt: "2026-11-03T18:00:00.000Z",
                  identifier: TICKET.identifier,
                  labels: ["Bug"],
                  matchedPhrases: [verifiedWidgetContext.conversationId],
                  parentIdentifier: null,
                  state: "Triage",
                  stateType: "triage",
                  title: "Campaign never sends",
                  url: TICKET.url,
                },
              ]
            : [],
          truncated: false,
        }),
    });
  return { calls, file };
};

const FIRST_REPORTED = /- First reported: 3 November 2026 at 14:05 UTC/u;

const fixed = {
  draft: () => Promise.resolve(fallbackDraft(turn)),
  evidence: () => Promise.resolve(evidence),
  now: () => new Date("2026-11-04T10:30:00.000Z"),
};

/** An in-memory run store keyed by message id, as the real claim is. */
function routeDeps(
  bug: Partial<WidgetDependencies>,
  t: { verifyMember?: WidgetDependencies["verifyMember"] } = {}
) {
  const runs = new Map<string, WidgetRun>();
  const base = {
    claim: (scope: WidgetContext, key: string, question: string) => {
      const run = runs.get(key);
      if (run) {
        return Promise.resolve({ fresh: false, run });
      }
      const created: WidgetRun = {
        completed_at: null,
        created_at: new Date(),
        decision: null,
        findings: null,
        id: crypto.randomUUID(),
        outcome: null,
        question,
        scope,
        session_id: null,
        stream_index: 0,
      };
      runs.set(key, created);
      return Promise.resolve({ fresh: true, run: created });
    },
    complete: (
      id: string,
      outcome: WidgetOutcome,
      findings: unknown
    ): Promise<WidgetRun | null> => {
      const run = [...runs.values()].find((entry) => entry.id === id);
      if (!run) {
        return Promise.resolve(null);
      }
      Object.assign(run, { completed_at: new Date(), findings, outcome });
      return Promise.resolve(run);
    },
    expireAll: () => Promise.resolve([]),
    latestScope: () => Promise.resolve(null),
    read: (id: string) =>
      Promise.resolve(
        [...runs.values()].find((entry) => entry.id === id) as WidgetRun
      ),
    verifyMember: t.verifyMember ?? (() => Promise.resolve(undefined)),
    ...bug,
  };
  return new Proxy(base, {
    get: (target, key: string) =>
      key in target
        ? target[key as keyof typeof target]
        : () => assert.fail(`a bug report must not call ${key}`),
  }) as unknown as WidgetDependencies;
}

const request = (body: Record<string, unknown>) =>
  new Request("https://foreman.example/internal/widget/message", {
    body: JSON.stringify({
      conversation_id: verifiedWidgetContext.conversationId,
      history: turn.history,
      message_id: MESSAGE_ID,
      organization_id: verifiedWidgetContext.organizationId,
      question: turn.question,
      ...body,
    }),
    headers: {
      authorization: "Bearer signed.user.identity",
      "content-type": "application/json",
      "x-acquisity-service-secret": SERVICE_SECRET,
    },
    method: "POST",
  });

const handlers = () => {
  const background: Promise<unknown>[] = [];
  return {
    background,
    from: () => assert.fail("a bug report starts no session"),
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
};

for (const role of ["member", "client"] as const) {
  test(`a ${role}'s bug_report files the ticket and replies with the fixed message`, async (t) => {
    enabled(t);
    const scope = { ...verifiedWidgetContext, role };
    const { calls, file } = linear(false);
    const members: string[] = [];
    const response = await receiveWidgetMessage(
      request({ mode: "bug_report" }),
      handlers(),
      30_000,
      () => Promise.resolve(scope),
      routeDeps(
        {
          bugReport: (s, runId, input, signal) =>
            fileBugReport(s, runId, input, signal, { ...fixed, file }),
        },
        {
          verifyMember: (checked) => {
            members.push(checked.role);
            return Promise.resolve(undefined as never);
          },
        }
      )
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "completed");
    assert.equal(body.decision, "allow");
    assert.equal(body.message, BUG_REPORT_LOGGED);
    assert.deepEqual(body.findings.ticket, {
      id: "ENG-901",
      url: "https://linear.app/acquisity/issue/ENG-901/new",
    });
    assert.equal(
      body.findings.report,
      "Filed the customer's bug report: ENG-901. Evidence: Sentry 1 found, Axiom nothing found, Inngest not checked, PostHog not checked, Jam not checked."
    );
    assert.equal(body.message.includes("TypeError"), false);
    assert.deepEqual(members, [role]);
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.creates[0].bug, true);
    assert.match(calls.creates[0].report, SENTRY_SECTION);
  });
}

test("a bug_report from someone no longer in the workspace is refused and files nothing", async (t) => {
  enabled(t);
  const response = await receiveWidgetMessage(
    request({ mode: "bug_report" }),
    handlers(),
    30_000,
    () => Promise.resolve({ ...verifiedWidgetContext, role: "member" }),
    routeDeps(
      { bugReport: () => assert.fail("must not file") },
      { verifyMember: () => Promise.reject(new Error("not a member")) }
    )
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Workspace could not be verified.",
  });
});

test("each evidence source reports items, nothing found, or not checked when it throws", async () => {
  const result = await gatherEvidence(verifiedWidgetContext, turn, RUN_ID, {
    Axiom: () => Promise.resolve({ status: "empty" }),
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

test("the ticket's Evidence section names each source's result", () => {
  const { description, title } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence,
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.equal(title, "Customer reports a problem from the support chat");
  assert.ok(
    description.includes(
      [
        "## Evidence",
        "### Sentry\n- [TypeError: cannot read schedule](https://acquisity.sentry.io/issues/123/)\n\n### Axiom\nNothing found.\n\n### Inngest\nNot checked: the lookup failed.\n\n### PostHog\nNot checked: PostHog is not in the support widget toolkit.\n\n### Jam\nNot checked: the customer sent no recording.",
      ].join("\n\n")
    )
  );
  assert.ok(
    description.startsWith(
      "## What's happening\n\nThe customer wrote:\n\n> I found a bug"
    )
  );
  assert.ok(
    description.includes(
      "One owner in Aaron Fraga's Workspace, reported from the support chat on 4 November 2026 at 10:30 UTC."
    )
  );
});

test("the largest report still fits Linear's 16,000-character description", () => {
  const long = "x".repeat(2000);
  const many = {
    items: Array.from({ length: 8 }, (_, i) => ({
      text: long,
      url: `https://acquisity.sentry.io/issues/${i}${"9".repeat(150)}/`,
    })),
    status: "found" as const,
  };
  const { description } = bugReportTicket({
    draft: fallbackDraft({ ...turn, question: long }),
    evidence: {
      Axiom: many,
      Inngest: many,
      Jam: many,
      PostHog: many,
      Sentry: many,
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn: {
      ...turn,
      history: Array.from({ length: 20 }, () => ({
        role: "customer" as const,
        text: long,
      })),
      question: long,
      screenshots: [long, long, long],
    },
  });
  assert.ok(description.length <= 16_000, `${description.length}`);
  assert.ok(description.includes("- …and"));
});

test("a recording's Jam link is on the ticket", () => {
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence,
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn: { ...turn, recording: { id: "jam-123" } },
  });
  assert.ok(
    description.includes(
      "2. Watch the [screen recording](https://jam.dev/c/jam-123). No screenshots."
    )
  );
  assert.ok(
    description.includes(
      "- Screen recording: [Jam recording](https://jam.dev/c/jam-123)"
    )
  );
});

test("filing still happens when every evidence lookup throws", async () => {
  const { calls, file } = linear(false);
  const failing = () => Promise.reject(new Error("down"));
  const outcome = await fileBugReport(
    verifiedWidgetContext,
    RUN_ID,
    turn,
    new AbortController().signal,
    {
      ...fixed,
      evidence: (scope, input, runId) =>
        gatherEvidence(scope, input, runId, {
          Axiom: failing,
          Inngest: failing,
          Jam: failing,
          PostHog: failing,
          Sentry: failing,
        }),
      file,
    }
  );
  assert.equal(calls.creates.length, 1);
  assert.equal(outcome.findings.ticket?.id, "ENG-901");
  assert.equal(
    calls.creates[0].report.split("Not checked: the lookup failed.").length - 1,
    5
  );
});

test("the ticket's first-reported time is when the customer tapped I found a bug, not when it was filed", async () => {
  const { calls, file } = linear(false);
  await fileBugReport(
    verifiedWidgetContext,
    RUN_ID,
    { ...turn, reportedAt: "2026-11-03T14:05:09.000Z" },
    new AbortController().signal,
    { ...fixed, file }
  );
  assert.match(calls.creates[0].report, FIRST_REPORTED);
});

test("a second bug_report for the same conversation returns the existing ticket and creates nothing", async () => {
  const { calls, file } = linear(true);
  const outcome = await fileBugReport(
    verifiedWidgetContext,
    RUN_ID,
    turn,
    new AbortController().signal,
    { ...fixed, file }
  );
  assert.equal(calls.creates.length, 0);
  assert.deepEqual(outcome.findings.ticket, {
    id: TICKET.identifier,
    url: TICKET.url,
  });
  assert.equal(outcome.message, BUG_REPORT_LOGGED);
});

test("bug_report_addition comments once, and a retry with the same message_id adds nothing", async (t) => {
  enabled(t);
  const comments: { body: string; id: string; identifier: string }[] = [];
  const deps = routeDeps({
    bugReportAddition: (s, runId, input, signal) =>
      addToBugReport(s, runId, input, signal, {
        comment: (identifier, body, id) => {
          comments.push({ body, id, identifier });
          return Promise.resolve();
        },
        file: () => assert.fail("the ticket exists"),
        find: () =>
          Promise.resolve({
            ...TICKET,
            assignee: null,
            createdAt: "2026-11-03T18:00:00.000Z",
            labels: [],
            matchedPhrases: [],
            parentIdentifier: null,
            state: "Triage",
            stateType: "triage",
            title: "Campaign never sends",
          }),
        now: fixed.now,
      }),
  });
  const send = () =>
    receiveWidgetMessage(
      request({
        mode: "bug_report_addition",
        question: "It started after I changed the sending window.",
        screenshots: ["The campaign page shows Scheduling."],
      }),
      handlers(),
      30_000,
      () => Promise.resolve({ ...verifiedWidgetContext, role: "client" }),
      deps
    );
  const first = await (await send()).json();
  const second = await (await send()).json();
  assert.equal(first.message, BUG_REPORT_ADDED);
  assert.deepEqual(first.findings.ticket, {
    id: TICKET.identifier,
    url: TICKET.url,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(comments, [
    {
      body: "The customer added in the support chat, 4 November 2026 at 10:30 UTC:\n\n> It started after I changed the sending window.\n\nScreenshot reading: The campaign page shows Scheduling.",
      id: additionCommentId(MESSAGE_ID),
      identifier: TICKET.identifier,
    },
  ]);
});

test("the addition's comment id is fixed per message", () => {
  assert.equal(additionCommentId(MESSAGE_ID), additionCommentId(MESSAGE_ID));
  assert.notEqual(
    additionCommentId(MESSAGE_ID),
    additionCommentId("66666666-6666-4666-8666-666666666666")
  );
  assert.match(additionCommentId(MESSAGE_ID), UUID_V4);
});

test("a bug_report_addition with no ticket files one and comments nothing", async () => {
  const { calls, file } = linear(false);
  const outcome = await addToBugReport(
    verifiedWidgetContext,
    RUN_ID,
    turn,
    new AbortController().signal,
    {
      ...fixed,
      comment: () => assert.fail("nothing to comment on"),
      file,
      find: () => Promise.resolve(undefined),
    }
  );
  assert.equal(calls.creates.length, 1);
  assert.equal(outcome.message, BUG_REPORT_ADDED);
  assert.deepEqual(outcome.findings.ticket, {
    id: "ENG-901",
    url: "https://linear.app/acquisity/issue/ENG-901/new",
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

test("Axiom reads the workspace and user from the app logs' fields map", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity-app");
  withEnv(t, "EXECUTOR_MCP_CONNECTOR_SUPPORT", "executor/test");
  const apls: string[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, _path: string, input: { apl: string }) => {
      apls.push(input.apl);
      return Promise.resolve({
        data: { structuredContent: { matches: [] } },
        http: { status: 200 },
        ok: true,
      });
    }
  );
  await EVIDENCE_SOURCES.Axiom(providerCtx(), verifiedWidgetContext, turn);
  assert.ok(
    apls[0]?.includes(
      `tostring(['fields']['organizationId']) == '${verifiedWidgetContext.organizationId}'`
    )
  );
  assert.ok(!apls[0]?.includes("['fields.organizationId']"));
});

test("Axiom lists each error message with its count", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity-app");
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
          text: "Campaign schedule failed (3 times, last 2026-11-04T10:00:00Z)",
        },
      ],
      status: "found",
    }
  );
});
