import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { type ProviderContext, widgetScopeBlock } from "./executor/dispatch.js";
import { verifiedWidgetContext } from "./widget.fixture.js";
import {
  type BugReportTurn,
  EVIDENCE_SOURCES,
  type Evidence,
  type EvidenceSource,
  gatherEvidence,
} from "./widget-bug-evidence.js";
import {
  additionCommentId,
  addToBugReport,
  BUG_REPORT_ADDED,
  BUG_REPORT_LOGGED,
  bugReportTicket,
  fallbackDraft,
  fileBugReport,
} from "./widget-bug-report.js";
import {
  receiveWidgetMessage,
  type WidgetDependencies,
} from "./widget-investigation.js";
import type { WidgetOutcome, WidgetRun } from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";
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
  const calls = {
    creates: [] as { bug?: boolean; report: string }[],
    followUps: [] as { identifier: string; runId: string }[],
  };
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
      followUp: (ticket, _summary, followUpRun) => {
        calls.followUps.push({
          identifier: ticket.identifier,
          runId: followUpRun,
        });
        return Promise.resolve();
      },
      owns: () => Promise.resolve(true),
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
            : { ...valid, page: "/dashboard\n\n## What should happen" },
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
          "- Sentry error events: 0123456789abcdef0123456789abcdef",
          "- Request failed: 10:21:02 POST /api/trpc/campaigns.launch 500 812ms",
          "- Console: 10:21:03 error TypeError: Cannot read properties of undefined (reading 'schedule')",
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

test("the largest report, with its scope block, still fits Linear's 16,000-character description", () => {
  const long = "x".repeat(2000);
  // Lines just short enough that every section fills its budget.
  const full = {
    items: Array.from({ length: 8 }, (_, i) => ({
      text: `${i} ${"<".repeat(20)}`,
      url: `https://acquisity.sentry.io/issues/${i}${"9".repeat(40)}/`,
    })),
    page: `/${"p".repeat(299)}`,
    recording: { text: "r", url: `https://us.posthog.com/${"r".repeat(200)}` },
    status: "found" as const,
  };
  const scope = { ...verifiedWidgetContext, organizationName: "W".repeat(500) };
  const { description } = bugReportTicket({
    // The fallback quotes the customer's first words, escaped: up to 6,000 characters.
    draft: fallbackDraft({ ...turn, history: [], question: "<".repeat(2000) }),
    evidence: {
      Axiom: full,
      Browser: full,
      Inngest: full,
      Jam: full,
      PostHog: full,
      Sentry: full,
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope,
    turn: {
      ...turn,
      browser: {
        browser: "b".repeat(200),
        consoleErrors: [],
        failedRequests: [],
        page: `/${"p".repeat(299)}`,
        replayId: "r".repeat(64),
        screen: "s".repeat(20),
        sentryEventIds: [],
      },
      history: Array.from({ length: 20 }, () => ({
        role: "customer" as const,
        text: long,
      })),
      question: long,
      recording: { id: "j".repeat(200) },
      screenshots: [long, long, long],
    },
  });
  const written = `${description}\n\n${widgetScopeBlock(scope)}`;
  assert.ok(written.length <= 16_000, `${written.length}`);
  assert.ok(written.length > 15_000, `${written.length}`);
  // The verbatim conversation is what gives up room.
  assert.ok(description.includes("  - Customer: xxx"));
});

test("a conversation whose lines leave slack in their budget is still trimmed to fit", () => {
  const scope = { ...verifiedWidgetContext, organizationName: "W".repeat(500) };
  const full = {
    items: Array.from({ length: 8 }, (_, i) => ({
      text: `${i} ${"<".repeat(20)}`,
      url: `https://acquisity.sentry.io/issues/${i}${"9".repeat(40)}/`,
    })),
    status: "found" as const,
  };
  for (const extra of [0, 50, 150, 400]) {
    const { description } = bugReportTicket({
      draft: fallbackDraft({
        ...turn,
        history: [],
        question: "<".repeat(2000),
      }),
      evidence: {
        Axiom: full,
        Browser: full,
        Inngest: full,
        Jam: full,
        PostHog: full,
        Sentry: full,
      },
      reportedAt: new Date("2026-11-04T10:30:00.000Z"),
      scope,
      turn: {
        ...turn,
        history: [
          { role: "customer", text: "a\n".repeat(495).slice(0, 990) },
          { role: "customer", text: "b".repeat(1490 + extra) },
        ],
        question: "c".repeat(210),
      },
    });
    const written = `${description}\n\n${widgetScopeBlock(scope)}`;
    assert.ok(written.length <= 16_000, `${extra}: ${written.length}`);
  }
});

test("a full browser section still shows a console line beside long requests", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(32));
  const failedRequest = (n: number) =>
    `Request failed: 10:21:0${n} POST /${"p".repeat(240)} 500 812ms`;
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      ...evidence,
      Browser: {
        items: [
          { text: `Sentry error events: ${ids.join(", ")}` },
          { text: failedRequest(1) },
          { text: "Console: 10:21:03 error Boom" },
          { text: failedRequest(2) },
          { text: failedRequest(3) },
        ],
        status: "found",
      },
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes("- Console: 10:21:03 error Boom"),
    description
  );
});

test("a console line too long for the room left after escaping is cut, not dropped", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(32));
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      ...evidence,
      Browser: {
        items: [
          { text: `Sentry error events: ${ids.join(", ")}` },
          {
            text: `Request failed: 10:21:01 POST /${"p".repeat(240)} 500 812ms`,
          },
          { text: `Console: 10:21:03 error Bad markup ${"<b>".repeat(90)}` },
        ],
        status: "found",
      },
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes("- Console: 10:21:03 error Bad markup &lt;b&gt;"),
    description
  );
  const section = description.slice(
    description.indexOf("### The customer's browser"),
    description.indexOf("### Sentry issues")
  );
  assert.ok(section.length <= 1100, `${section.length}`);
});

test("outside text in an evidence line can't become a link", () => {
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      ...evidence,
      Browser: {
        items: [
          {
            text: "Console: 10:21:03 error [Reset your password](https://evil.example)",
          },
        ],
        status: "found",
      },
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.ok(
    description.includes(
      "- Console: 10:21:03 error \\[Reset your password\\](https://evil.example)"
    ),
    description
  );
});

test("a PostHog recording is linked once, under How to see it", () => {
  const url = `https://us.posthog.com/project/12345/replay/${"a".repeat(8)}`;
  const { description } = bugReportTicket({
    draft: fallbackDraft(turn),
    evidence: {
      ...evidence,
      PostHog: {
        items: [{ text: "Viewed /dashboard at 10:21:15 UTC" }],
        page: "/dashboard",
        recording: { text: "PostHog recording of this session", url },
        status: "found",
      },
    },
    reportedAt: new Date("2026-11-04T10:30:00.000Z"),
    scope: verifiedWidgetContext,
    turn,
  });
  assert.equal(description.split(url).length - 1, 1);
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

test("a second bug_report for the same conversation returns the existing ticket, creates nothing and follows up on it once", async () => {
  const { calls, file } = linear(true);
  const outcome = await fileBugReport(
    verifiedWidgetContext,
    RUN_ID,
    turn,
    new AbortController().signal,
    { ...fixed, file }
  );
  assert.equal(calls.creates.length, 0);
  assert.deepEqual(calls.followUps, [
    { identifier: TICKET.identifier, runId: RUN_ID },
  ]);
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
