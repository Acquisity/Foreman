import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { parseWidgetFeedbackMarker } from "./widget-feedback.js";
import { fileInvestigatorTicket } from "./widget-handoff.js";
import {
  type ProblemReport,
  receiveProblemReport,
} from "./widget-problem-report.js";
import { widgetAuth } from "./widget-scope.js";
import type { WidgetTicketInput } from "./widget-ticket.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

const SERVICE_SECRET = "s".repeat(40);
const REPORT_ID = "66666666-6666-4666-8666-666666666666";
const REPLY_ID = "77777777-7777-4777-8777-777777777777";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const ANY_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/u;

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
}

const report = (body: Partial<ProblemReport> = {}, secret = SERVICE_SECRET) =>
  new Request("https://foreman.example/internal/widget/report", {
    body: JSON.stringify({
      conversation_id: scope.conversationId,
      details: "It told me to open a Billing tab that isn't there.",
      history: [
        { role: "customer", text: "How do I change my plan?" },
        { role: "assistant", text: "Open the Billing tab in Settings." },
      ],
      message_id: REPLY_ID,
      organization_id: scope.organizationId,
      report_id: REPORT_ID,
      run_id: RUN_ID,
      ...body,
    }),
    headers: {
      authorization: "Bearer signed.user.identity",
      "content-type": "application/json",
      "x-acquisity-service-secret": secret,
    },
    method: "POST",
  });

const filing = () => {
  const filed: { input: WidgetTicketInput; runId: string | undefined }[] = [];
  return {
    filed,
    overrides: {
      draft: () =>
        Promise.resolve({
          open: "Check why the reply named a tab that does not exist.",
          title: "Foreman sent the customer to a Billing tab that isn't there",
          told: "Foreman said to open the Billing tab in Settings.",
          wants: "The customer wants to change their plan.",
        }),
      file: (
        _scope: unknown,
        input: WidgetTicketInput,
        _signal: AbortSignal,
        runId?: string
      ) => {
        filed.push({ input, runId });
        return Promise.resolve({
          existing: false,
          identifier: "ENG-50",
          refund: false,
          url: "https://linear.app/acquisity/issue/ENG-50/x",
        });
      },
      member: () => Promise.resolve(),
      now: () => new Date("2026-11-26T12:00:00.000Z"),
      verify: () => Promise.resolve(scope),
    },
  };
};

test("the customer's Report a problem is filed through the one widget filer, with its ids in the Support report", async (t) => {
  enabled(t);
  const { filed, overrides } = filing();
  const response = await receiveProblemReport(
    report({
      app_version: "0123456789abcdef",
      browser: {
        browser: "Chrome 131",
        consoleErrors: [],
        failedRequests: [],
        page: "/dashboard",
        replayId: null,
        screen: "1440x900",
        sentryEventIds: [],
      },
    }),
    overrides
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    existing: false,
    ticket: {
      id: "ENG-50",
      url: "https://linear.app/acquisity/issue/ENG-50/x",
    },
  });
  const [{ input }] = filed;
  assert.equal(input.entry, "problem");
  assert.equal(
    input.title,
    "Foreman sent the customer to a Billing tab that isn't there"
  );
  // Scoped to the chat and the reply, so a reused form id never collides.
  assert.equal(
    input.retryKey,
    `problem-report:${scope.conversationId}:${REPLY_ID}:${REPORT_ID}`
  );
  assert.doesNotMatch(input.body, ANY_UUID);
  const sections = input.report.join("\n\n");
  assert.ok(sections.includes(`Reported reply: ${REPLY_ID}`));
  assert.ok(sections.includes("App version: 0123456789ab"));
  assert.ok(sections.includes("Foreman: Open the Billing tab in Settings."));
  // The widget-feedback route reads its ids from the Support report's last line.
  assert.deepEqual(parseWidgetFeedbackMarker(sections), {
    at: "2026-11-26T12:00:00.000Z",
    conversation: scope.conversationId,
    message: REPLY_ID,
    replay: null,
    run: RUN_ID,
  });
});

test("a report without the service secret, identity or workspace files nothing", async (t) => {
  enabled(t);
  const { filed, overrides } = filing();
  assert.equal(
    (await receiveProblemReport(report({}, "wrong"), overrides)).status,
    403
  );
  const denied = await receiveProblemReport(report(), {
    ...overrides,
    member: () => Promise.reject(new Error("not a member")),
  });
  assert.equal(denied.status, 403);
  const malformed = await receiveProblemReport(
    report({ report_id: "not-a-uuid" }),
    overrides
  );
  assert.equal(malformed.status, 400);
  assert.equal(filed.length, 0);
});

test("a report that cannot be filed says so, so the app can ask the customer to try again", async (t) => {
  enabled(t);
  const { overrides } = filing();
  const response = await receiveProblemReport(report(), {
    ...overrides,
    file: () => Promise.resolve({ error: "Linear did not accept the ticket." }),
  });
  assert.equal(response.status, 502);
});

test("widget_file_ticket drafts the ticket from the investigator's findings and the customer's message, and keeps the findings for the Support report", async () => {
  const initiator = widgetAuth(scope, RUN_ID);
  const drafted: unknown[] = [];
  const filed: WidgetTicketInput[] = [];
  const result = await fileInvestigatorTicket(
    {
      abortSignal: new AbortController().signal,
      getToken: async () => ({ token: "t" }),
      session: { auth: { current: initiator, initiator } },
    } as never,
    {
      summary:
        "Workspace 22222222-2222-4222-8222-222222222222: inbox sync fails with 401 since 3 Nov.",
      title: "Inbox sync failing",
    },
    {
      draft: (facts) => {
        drafted.push(facts);
        return Promise.resolve({
          open: "Find why the inbox sync is refused.",
          title: "Customer's inbox stopped syncing",
          told: "Foreman said the team will look at it.",
          wants: "The customer wants their inbox to sync again.",
        });
      },
      file: (_ctx, ticket) => {
        filed.push(ticket);
        return Promise.resolve({
          existing: false,
          identifier: "ENG-51",
          refund: false,
          url: "https://linear.app/acquisity/issue/ENG-51/x",
        });
      },
      turns: (owner, runId) => {
        assert.equal(runId, RUN_ID);
        assert.equal(owner.conversationId, scope.conversationId);
        return Promise.resolve({
          history: [
            { role: "customer", text: "My inbox shows an error." },
            { role: "assistant", text: "Reconnect it from Settings." },
          ],
          question: "I reconnected it and it still fails",
        });
      },
    }
  );
  assert.equal("identifier" in result && result.identifier, "ENG-51");
  assert.equal(drafted.length, 1);
  const [input] = filed;
  assert.equal(input?.entry, "tool");
  assert.equal(input?.title, "Customer's inbox stopped syncing");
  assert.ok(!input?.body.includes("22222222-2222-4222-8222-222222222222"));
  assert.ok(
    input?.report.join("\n").includes("22222222-2222-4222-8222-222222222222")
  );
  // The report keeps the earlier turns, so the team sees what was tried.
  const sections = input?.report.join("\n") ?? "";
  assert.ok(
    sections.includes("- Foreman: Reconnect it from Settings."),
    sections
  );
  assert.ok(
    sections.includes("- Customer: I reconnected it and it still fails")
  );
  // The refund check still reads the investigator's own words.
  assert.ok(input?.summary.startsWith("Inbox sync failing\n\n"));
});
