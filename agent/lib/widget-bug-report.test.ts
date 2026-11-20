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
  /### Sentry issues\n- \[TypeError: cannot read schedule\]\(https:\/\/acquisity\.sentry\.io\/issues\/123\/\)/u;
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
  Browser: { status: "not_sent" },
  Inngest: { reason: "the lookup failed", status: "unchecked" },
  Jam: { status: "not_sent" },
  PostHog: { reason: "the lookup failed", status: "unchecked" },
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
      "Filed the customer's bug report: ENG-901. Evidence: Browser not sent, Sentry 1 found, Axiom nothing found, Inngest not checked, PostHog not checked, Jam not sent."
    );
    assert.equal(body.message.includes("TypeError"), false);
    assert.deepEqual(members, [role]);
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.creates[0].bug, true);
    assert.match(calls.creates[0].report, SENTRY_SECTION);
  });
}

for (const [name, browser, expected] of [
  ["a valid capture reaches the report", "valid", true],
  [
    "an invalid capture is dropped and the report still files",
    "invalid",
    false,
  ],
] as const) {
  test(`bug_report browser: ${name}`, async (t) => {
    enabled(t);
    const received: BugReportTurn[] = [];
    const valid = {
      browser: "Chrome 131",
      consoleErrors: ["10:21:03 error TypeError: x"],
      failedRequests: [],
      page: "/dashboard/acme",
      replayId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      screen: "1440x900",
      sentryEventIds: [],
    };
    const response = await receiveWidgetMessage(
      request({
        browser:
          browser === "valid"
            ? valid
            : { ...valid, page: "/dashboard?token=secret" },
        mode: "bug_report",
      }),
      handlers(),
      30_000,
      () => Promise.resolve(verifiedWidgetContext),
      routeDeps({
        bugReport: (_s, _runId, input) => {
          received.push(input);
          return Promise.resolve({
            findings: {
              confidence: "high",
              facts: [],
              needsHuman: false,
              recommendation: "",
              report: "Filed",
              ticket: { id: "ENG-901", url: "https://linear.app/x" },
            },
            message: BUG_REPORT_LOGGED,
          });
        },
      })
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, BUG_REPORT_LOGGED);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0]?.browser, expected ? valid : undefined);
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

test("What we know so far lists sources that found something, then folds the rest into one line each", () => {
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
        "## What we know so far",
        "### Sentry issues\n- [TypeError: cannot read schedule](https://acquisity.sentry.io/issues/123/)",
        "Checked, nothing found: Axiom.",
        "Couldn't check: Inngest (the lookup failed), PostHog (the lookup failed).",
        "## Done when",
      ].join("\n\n")
    ),
    description
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
  // Nothing is said about a source the customer or the app sent nothing for.
  assert.ok(!description.includes("Jam"));
  assert.ok(!description.includes("Browser"));
});

test("an unstated expectation leaves out its section, and the page and proof are in How to see it", () => {
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence,
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(!description.includes("Not stated."));
  assert.ok(!description.includes("## What should happen"));
  assert.ok(!description.includes("## Evidence"));
  assert.ok(
    description.includes(
      "## How to see it\n\n1. The page the customer was on is unknown.\n2. Do what the customer describes above.\n3. No recording: the app sent no replay and the customer sent no screen recording. No screenshots. Open the support conversation"
    ),
    description
  );
  assert.ok(
    description.includes(").\n\nNot reproduced yet.\n\n## What we know so far")
  );
  // The workspace and conversation are in the server's scope block, so the details don't repeat them.
  assert.ok(!description.includes("- Workspace:"));
  assert.ok(!description.includes("- Conversation:"));
  assert.equal(
    description.split(verifiedWidgetContext.conversationId).length - 1,
    1
  );
});

test("a stated expectation keeps its section", () => {
  const { description } = bugReportTicket({
    draft: {
      impact: null,
      title: "Campaign stays on Scheduling and never sends",
      whatShouldHappen: "The campaign starts sending.",
      whatsHappening: "The campaign stays on Scheduling.",
    },
    evidence,
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes(
      "## What should happen\n\nThe campaign starts sending.\n\n## Who it hits"
    )
  );
  assert.ok(
    description.includes(
      "- [ ] If it's a bug: the campaign starts sending on the customer's workspace"
    )
  );
});

const capture = {
  browser: "Chrome 131",
  consoleErrors: [
    "10:21:03 error TypeError: Cannot read properties of undefined (reading 'schedule')",
  ],
  failedRequests: ["10:21:02 POST /api/trpc/campaigns.launch 500 812ms"],
  page: "/dashboard/acme/campaigns/42",
  replayId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  screen: "1440x900",
  sentryEventIds: ["0123456789abcdef0123456789abcdef"],
};

test("the browser capture names the page, links the Sentry replay and lists console errors and failed requests", async (t) => {
  withEnv(t, "WIDGET_SENTRY_ORG_SLUG", "acquisity-ai");
  const captured = { ...turn, browser: capture };
  const found = await EVIDENCE_SOURCES.Browser(
    {} as ProviderContext,
    verifiedWidgetContext,
    captured
  );
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: { ...evidence, Browser: found },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn: {
      ...captured,
      screenshots: [
        "[Screenshot the customer attached, as read by an image model]\nScreen: Campaigns list",
      ],
    },
  });
  assert.ok(
    description.includes(
      "1. Open `/dashboard/acme/campaigns/42`, the page the customer was on.\n2. Do what the customer describes above.\n3. Watch the [Sentry replay](https://acquisity-ai.sentry.io/replays/a1b2c3d4e5f60718293a4b5c6d7e8f90/) of the minute before they reported it. One screenshot in the support conversation"
    ),
    description
  );
  assert.ok(
    description.includes(
      [
        "## What we know so far",
        [
          "### The customer's browser",
          "- Console: 10:21:03 error TypeError: Cannot read properties of undefined (reading 'schedule')",
          "- Request failed: 10:21:02 POST /api/trpc/campaigns.launch 500 812ms",
          "- Sentry error events: 0123456789abcdef0123456789abcdef",
        ].join("\n"),
        "### Sentry issues",
      ].join("\n\n")
    ),
    description
  );
  assert.ok(description.includes("- Browser: Chrome 131, screen 1440x900"));
  // The reading sits under the customer's message without the image model's label.
  assert.ok(
    description.includes(
      "  - Customer: My campaign stays on Scheduling and never sends.\n    - Screenshot: Screen: Campaigns list"
    ),
    description
  );
  assert.ok(!description.includes("[Screenshot the customer attached"));
});

test("with no browser capture, the page comes from the last PostHog page view and a PostHog recording is the proof", () => {
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      ...evidence,
      PostHog: {
        items: [
          {
            text: "PostHog recording of this session",
            url: "https://us.posthog.com/project/12345/replay/01900000-0000-7000-8000-000000000001",
          },
          { text: "Viewed /dashboard/acme/crm/tasks at 10:21:15 UTC" },
        ],
        page: "/dashboard/acme/crm/tasks",
        recording: {
          text: "PostHog recording of this session",
          url: "https://us.posthog.com/project/12345/replay/01900000-0000-7000-8000-000000000001",
        },
        status: "found",
      },
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes(
      "1. Open `/dashboard/acme/crm/tasks`, the page the customer was on (their last page view).\n2. Do what the customer describes above.\n3. Watch the [PostHog recording](https://us.posthog.com/project/12345/replay/01900000-0000-7000-8000-000000000001) of the session."
    ),
    description
  );
});

test("every source with nothing found is one line", () => {
  const empty = { status: "empty" } as const;
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      Axiom: empty,
      Browser: empty,
      Inngest: empty,
      Jam: { status: "not_sent" },
      PostHog: empty,
      Sentry: empty,
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes(
      "## What we know so far\n\nChecked, nothing found: Browser, Sentry, Axiom, Inngest, PostHog.\n\n## Done when"
    ),
    description
  );
  assert.ok(!description.includes("Couldn't check"));
  assert.ok(!description.includes("###"));
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
      Browser: many,
      Inngest: many,
      Jam: many,
      PostHog: many,
      Sentry: many,
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn: {
      ...turn,
      browser: {
        browser: "b".repeat(200),
        consoleErrors: Array.from({ length: 30 }, () => "c".repeat(500)),
        failedRequests: Array.from({ length: 30 }, () => "f".repeat(500)),
        page: `/${"p".repeat(299)}`,
        replayId: "r".repeat(64),
        screen: "s".repeat(20),
        sentryEventIds: Array.from({ length: 5 }, () => "e".repeat(64)),
      },
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
      "3. Watch their [Jam screen recording](https://jam.dev/c/jam-123). No screenshots."
    ),
    description
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
          Browser: failing,
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
  assert.ok(
    calls.creates[0].report.includes(
      "Couldn't check: Browser (the lookup failed), Sentry (the lookup failed), Axiom (the lookup failed), Inngest (the lookup failed), PostHog (the lookup failed), Jam (the lookup failed)."
    )
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
      `| where tostring(['fields']['organizationId']) == '${verifiedWidgetContext.organizationId}' or tostring(['fields']['userId']) == '${verifiedWidgetContext.userId}'`,
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

test("an Axiom answer without the query's table, or an error, is reported as not checked", async (t) => {
  withEnv(t, "WIDGET_AXIOM_APP_DATASET", "acquisity");
  answer(t, { content: [{ text: '{"matches": []}', type: "text" }] });
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
  assert.deepEqual(items[0], recording);
  assert.deepEqual(result.status === "found" && result.recording, recording);
  assert.equal(result.status === "found" && result.page, "/dashboard");
  assert.deepEqual(items[1], { text: "Viewed /dashboard at 18:53:07 UTC" });
  assert.ok(
    items[2]?.text.startsWith("Error toast CAMPAIGN_SEND_FAILED on /campaigns/")
  );
  assert.equal(items[2]?.text.length, 300);
  assert.ok(!items.some(({ text }) => text.includes("person")));
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
