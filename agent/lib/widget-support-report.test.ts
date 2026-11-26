import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { parseWidgetFeedbackMarker } from "./widget-feedback.js";
import {
  fitReport,
  legacyFeedbackTicket,
  linkedTickets,
  saveSupportReport,
  supportReportContent,
  supportReportId,
  verifiedScopeSection,
} from "./widget-support-report.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

type Answer = unknown | ((variables: Record<string, unknown>) => unknown);

/** Answers each request by its name, and records what was sent. */
const linear = (answers: Record<string, Answer>) => {
  const sent: { name: string; variables: Record<string, unknown> }[] = [];
  const request = <T>(
    name: string,
    _query: string,
    variables: Record<string, unknown>
  ): Promise<T> => {
    sent.push({ name, variables });
    const { [name]: answer } = answers;
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return Promise.resolve(
      (typeof answer === "function" ? answer(variables) : answer) as T
    );
  };
  return { request: request as never, sent };
};

const taken = Object.assign(new Error("Linear error"), {
  body: [{ message: "conflict on insert of Document" }],
});
const { signal } = new AbortController();
const ADDITION = { key: "run-1", text: "## Added\n\n- Customer: again" };

test("a first filing creates the report under the ticket's fixed id, marked with its key", async () => {
  const { request, sent } = linear({
    SupportReportCreate: { documentCreate: { success: true } },
  });
  assert.equal(
    await saveSupportReport(
      "ENG-1",
      "## Verified scope",
      ADDITION,
      scope,
      request
    ),
    true
  );
  const input = sent[0]?.variables.input as Record<string, string>;
  assert.equal(input.id, supportReportId("ENG-1"));
  assert.equal(input.title, "Support report");
  assert.equal(input.issueId, "ENG-1");
  assert.ok(input.content.startsWith("<!-- support-report-addition run-1 -->"));
});

test("a later filing appends once: a retry with the same key adds nothing", async () => {
  let stored = "## Verified scope\n\n<!-- support-report-addition run-0 -->";
  const { request, sent } = linear({
    SupportReportCreate: taken,
    SupportReportRead: () => ({ document: { content: stored } }),
    SupportReportUpdate: (variables: Record<string, unknown>) => {
      stored = (variables.input as { content: string }).content;
      return { documentUpdate: { success: true } };
    },
  });
  await saveSupportReport("ENG-1", "unused", ADDITION, scope, request);
  await saveSupportReport("ENG-1", "unused", ADDITION, scope, request);
  assert.equal(
    sent.filter(({ name }) => name === "SupportReportUpdate").length,
    1
  );
  assert.equal(stored.split("- Customer: again").length - 1, 1);
});

test("what is stored keeps the feedback line last, so the widget-feedback route still finds it after a retry and a second report", async () => {
  let stored = "";
  const { request } = linear({
    SupportReportCreate: (variables: Record<string, unknown>) => {
      if (stored) {
        throw taken;
      }
      stored = (variables.input as { content: string }).content;
      return { documentCreate: { success: true } };
    },
    SupportReportRead: () => ({ document: { content: stored } }),
    SupportReportUpdate: (variables: Record<string, unknown>) => {
      stored = (variables.input as { content: string }).content;
      return { documentUpdate: { success: true } };
    },
  });
  const line = (message: string) =>
    `<!-- chat-widget-feedback conversation=${scope.conversationId} message=${message} run=none replay=none at=2026-11-26T12:00:00.000Z -->`;
  const content = supportReportContent(scope, "problem", [
    "## Report",
    line("reply-a"),
  ]);
  await saveSupportReport(
    "ENG-1",
    content,
    { key: "r1", text: "unused" },
    scope,
    request
  );
  assert.equal(parseWidgetFeedbackMarker(stored)?.message, "reply-a");
  await saveSupportReport(
    "ENG-1",
    content,
    { key: "r2", text: `## Added\n\n${line("reply-a")}` },
    scope,
    request
  );
  await saveSupportReport(
    "ENG-1",
    content,
    { key: "r2", text: `## Added\n\n${line("reply-a")}` },
    scope,
    request
  );
  assert.equal(parseWidgetFeedbackMarker(stored)?.message, "reply-a");
  assert.equal(stored.split("support-report-addition r2").length - 1, 1);
});

test("a refused write is logged and the filing goes on", async (t) => {
  const warned: unknown[] = [];
  t.mock.method(console, "warn", (line: unknown) => warned.push(line));
  const { request } = linear({
    SupportReportCreate: { documentCreate: { success: false } },
  });
  assert.equal(
    await saveSupportReport("ENG-1", "x", ADDITION, scope, request),
    false
  );
  assert.equal(warned.length, 1);
  assert.ok(String(warned[0]).includes("widget.ticket.report_unsaved"));
});

test("a report too long to keep whole keeps its verified scope and its last line", () => {
  const line = `<!-- chat-widget-feedback conversation=${scope.conversationId} message=none run=none replay=none at=2026-11-26T12:00:00.000Z -->`;
  const content = supportReportContent(scope, "problem", [
    "x".repeat(70_000),
    line,
  ]);
  assert.ok(content.length <= 60_000);
  assert.ok(content.startsWith("## Verified scope"));
  assert.ok(parseWidgetFeedbackMarker(content));
  const appended = fitReport(content, `\n\nnew ${"y".repeat(100)}\n\n${line}`);
  assert.ok(appended.length <= 60_000);
  assert.ok(appended.startsWith("## Verified scope"));
  assert.ok(appended.endsWith(line));
});

const linkNode = (
  identifier: string,
  report: string | null,
  title = "Support chat"
) => ({
  issue: {
    documents: { nodes: report === null ? [] : [{ content: report }] },
    identifier,
    labels: { nodes: [] },
    project: { id: "84ab288a-6a7b-4316-ab6f-f67809a40211" },
    state: { type: "triage" },
    url: `https://linear.app/acquisity/issue/${identifier}/x`,
  },
  title,
  url: `https://app.acquisity.ai/dashboard/admin/support?conversation=${scope.conversationId}`,
});

test("a feedback ticket linked to the chat names the reply its first report is about; a teammate's inbox link, or a link with no Support report of this chat, is not Foreman's", async () => {
  const { request, sent } = linear({
    SupportChatTickets: {
      attachmentsForURL: {
        nodes: [
          linkNode(
            "ENG-1",
            `${verifiedScopeSection(scope, "problem")}\n\nx\n<!-- chat-widget-feedback conversation=${scope.conversationId} message=reply-a run=none -->\nlater\n<!-- chat-widget-feedback conversation=${scope.conversationId} message=reply-a run=none -->`
          ),
          linkNode("ENG-2", null, "Support conversation · someone"),
          // A link Linear moved onto a shared ticket when another customer's case was marked its duplicate.
          linkNode(
            "ENG-3",
            verifiedScopeSection(
              {
                ...scope,
                conversationId: "0b3a6f2e-1c4d-4e5f-8a9b-7c6d5e4f3a2b",
              },
              "bug"
            )
          ),
          linkNode("ENG-4", null),
          // Report text that quotes this chat's scope line below another chat's verified scope.
          linkNode(
            "ENG-5",
            `${verifiedScopeSection({ ...scope, conversationId: "0b3a6f2e-1c4d-4e5f-8a9b-7c6d5e4f3a2b" }, "bug")}\n\n## Verified scope\n\n- Support conversation: ${scope.conversationId}\n`
          ),
        ],
      },
    },
  });
  assert.deepEqual(await linkedTickets(scope.conversationId, signal, request), [
    {
      identifier: "ENG-1",
      kind: "feedback",
      reported: "reply-a",
      stateType: "triage",
      url: "https://linear.app/acquisity/issue/ENG-1/x",
    },
  ]);
  assert.equal(
    sent[0]?.variables.url,
    `https://app.acquisity.ai/dashboard/admin/support?conversation=${scope.conversationId}`
  );
});

test("an earlier feedback ticket counts only in the Chat Widget project, for this chat and reply", async () => {
  const issue = (
    description: string,
    project = "84ab288a-6a7b-4316-ab6f-f67809a40211",
    type = "triage"
  ) =>
    linear({
      LegacyFeedbackTicket: {
        issue: {
          description,
          identifier: "ENG-7",
          project: { id: project },
          state: { type },
          url: "https://linear.app/acquisity/issue/ENG-7/x",
        },
      },
    }).request;
  const line = (conversation: string, message: string) =>
    `## Report\n\n<!-- chat-widget-feedback conversation=${conversation} message=${message} run=none at=2026-11-01T00:00:00Z -->`;
  const check = (request: never, message = "reply-a") =>
    legacyFeedbackTicket(
      "ENG-7",
      scope.conversationId,
      message,
      signal,
      request
    );
  assert.equal(
    (await check(issue(line(scope.conversationId, "reply-a"))))?.identifier,
    "ENG-7"
  );
  assert.equal(
    await check(issue(line(scope.conversationId, "reply-a")), "reply-b"),
    null
  );
  assert.equal(await check(issue(line("other-chat", "reply-a"))), null);
  assert.equal(
    await check(issue(line(scope.conversationId, "reply-a"), "other-project")),
    null
  );
  // A repeat only adds to it, whatever its state, as before.
  assert.equal(
    (
      await check(
        issue(line(scope.conversationId, "reply-a"), undefined, "canceled")
      )
    )?.identifier,
    "ENG-7"
  );
});

test("a long report cut to fit loses its oldest text, never the newest additions' marks", () => {
  const scopeHead = "## Verified scope\n\n- Workspace ID: x\n\n";
  const existing = `${scopeHead}<!-- support-report-addition old -->\n\n${"o".repeat(40_000)}\n\n<!-- support-report-addition newest -->\n\n${"n".repeat(15_000)}`;
  const kept = fitReport(
    existing,
    `\n\n<!-- support-report-addition next -->\n\n${"x".repeat(10_000)}`
  );
  assert.ok(kept.length <= 60_000);
  assert.ok(kept.startsWith(scopeHead));
  assert.ok(kept.includes("support-report-addition newest"));
  assert.ok(kept.includes("support-report-addition next"));
  // The oldest addition's text is what gives way.
  assert.ok(kept.split("o").length - 1 < 40_000);
});
