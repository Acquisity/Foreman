import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { WidgetTicketReceipt } from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";
import type { LinkedTicket } from "./widget-support-report.js";
import {
  appTicketContext,
  existingTicket,
  fileTicketFor,
  fileWidgetTicket,
  legacyKind,
  type WidgetTicketInput,
} from "./widget-ticket.js";

process.env.ACQUISITY_ORIGIN ??= "https://app.acquisity.ai";

const SUPPORT = "4534deb2-6bbc-4e30-ad38-48963f414d14";
const REFUND_LABEL = "9120e30d-e188-4972-940b-20005b7f6d03";
const CHAT_WIDGET = "84ab288a-6a7b-4316-ab6f-f67809a40211";
const BROKE_AGAIN = /- Customer: It broke again\./u;
const OPENS_WITH_SCOPE = /^## Verified scope/u;

const ask = (summary: string): WidgetTicketInput => ({
  body: summary,
  entry: "handoff",
  report: ["## Conversation (oldest first)", `- Customer: ${summary}`],
  summary,
  title: "Support",
});

const reading = (
  project: string | null,
  labels: string[]
): Parameters<typeof legacyKind>[1] => ({
  client: () =>
    Promise.resolve({
      data: {
        data: {
          issue: {
            assignee: null,
            id: "issue-1",
            identifier: "ENG-1",
            labels: { nodes: labels.map((id) => ({ id, name: id })) },
            parent: null,
            priority: 0,
            project: project ? { id: project, name: "Project" } : null,
            state: { name: "Triage" },
            team: { id: "team" },
            url: "https://linear.app/acquisity/issue/ENG-1",
          },
        },
      },
      status: 200,
    }),
});

test("an old ticket holds a refund only in the Support project with the Refund label", async () => {
  assert.equal(
    await legacyKind("ENG-1", reading(SUPPORT, [REFUND_LABEL])),
    "refund"
  );
  // Moved to a product project but still labelled Refund.
  assert.equal(
    await legacyKind("ENG-1", reading("other-project", [REFUND_LABEL])),
    "case"
  );
  assert.equal(await legacyKind("ENG-1", reading(SUPPORT, [])), "case");
  assert.equal(await legacyKind("ENG-1", reading(CHAT_WIDGET, [])), "feedback");
  assert.equal(
    await legacyKind("ENG-1", {
      client: () => Promise.resolve({ data: null, status: 500 }),
    }),
    "case"
  );
});

test("a reused ticket is routed to billing exactly when it is the chat's refund ticket", () => {
  const issue = {
    identifier: "ENG-1",
    url: "https://linear.app/acquisity/issue/ENG-1",
  };
  assert.deepEqual(existingTicket({ ...issue, kind: "case" }), {
    existing: true,
    identifier: "ENG-1",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-1",
  });
  assert.equal(existingTicket({ ...issue, kind: "refund" }).refund, true);
});

const noLinks = {
  linked: () => Promise.resolve([] as LinkedTicket[]),
  report: () => Promise.resolve(true),
};

test("code filing then a tool call in one run reuses the confirmed receipt despite an empty Linear search", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  let receipt: WidgetTicketReceipt | null = null;
  let writes = 0;
  let searches = 0;
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = ask("The customer asked for a person.");
  const deps = {
    ...noLinks,
    create: () => {
      writes += 1;
      return Promise.resolve({
        data: {
          id: "ENG-42",
          url: "https://linear.app/acquisity/issue/ENG-42/support",
        },
        ok: true as const,
      });
    },
    readReceipt: async () => receipt,
    refund: () => Promise.resolve(false),
    saveReceipt: (
      _scope: WidgetContext,
      id: string,
      saved: WidgetTicketReceipt
    ) => {
      assert.equal(id, runId);
      receipt = saved;
      return Promise.resolve();
    },
    search: () => {
      searches += 1;
      return Promise.resolve({
        createdAfter: null,
        issues: [],
        truncated: false,
      });
    },
  };
  const { signal } = new AbortController();
  const code = await fileTicketFor(scope, input, signal, runId, deps);
  const investigator = await fileWidgetTicket(
    appTicketContext(scope, signal, runId),
    input,
    deps
  );
  assert.deepEqual(investigator, code);
  assert.equal(writes, 1);
  assert.equal(searches, 1);
});

test("a confirmed ticket stays confirmed when its receipt cannot be saved", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { signal } = new AbortController();
  const filed = await fileTicketFor(
    scope,
    ask("The customer asked for a person."),
    signal,
    runId,
    {
      ...noLinks,
      create: () =>
        Promise.resolve({
          data: {
            id: "ENG-43",
            url: "https://linear.app/acquisity/issue/ENG-43/support",
          },
          ok: true as const,
        }),
      readReceipt: async () => null,
      refund: () => Promise.resolve(false),
      saveReceipt: () => Promise.reject(new Error("db down")),
      search: () =>
        Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
    }
  );
  assert.ok(!("error" in filed));
  assert.equal("identifier" in filed && filed.identifier, "ENG-43");
});

test("an abort during the receipt save propagates instead of becoming a ticket error", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const controller = new AbortController();
  await assert.rejects(
    fileTicketFor(
      scope,
      ask("The customer asked for a person."),
      controller.signal,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      {
        ...noLinks,
        create: () =>
          Promise.resolve({
            data: {
              id: "ENG-44",
              url: "https://linear.app/acquisity/issue/ENG-44/support",
            },
            ok: true as const,
          }),
        readReceipt: async () => null,
        refund: () => Promise.resolve(false),
        saveReceipt: () => {
          controller.abort();
          return Promise.reject(new Error("aborted"));
        },
        search: () =>
          Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
      }
    )
  );
});

const hit = (identifier: string, stateType: string) => ({
  assignee: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  identifier,
  labels: [],
  matchedPhrases: [scope.conversationId],
  parentIdentifier: null,
  state: stateType,
  stateType,
  title: identifier,
  url: `https://linear.app/acquisity/issue/${identifier}/x`,
});

test("a search hit that only mentions the conversation is skipped: the follow-up lands on the conversation's own ticket", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const followed: { identifier: string; runId: string; stateType: string }[] =
    [];
  const checked: string[] = [];
  const { signal } = new AbortController();
  const filed = await fileTicketFor(
    scope,
    ask("It broke again."),
    signal,
    runId,
    {
      ...noLinks,
      create: () => assert.fail("the conversation already has a ticket"),
      followUp: (ticket, _summary, followUpRun) => {
        followed.push({
          identifier: ticket.identifier,
          runId: followUpRun,
          stateType: ticket.stateType,
        });
        return Promise.resolve();
      },
      kind: () => Promise.resolve("case" as const),
      owns: (identifier, owner) => {
        checked.push(identifier);
        assert.equal(owner.conversationId, scope.conversationId);
        return Promise.resolve(identifier === "ENG-6");
      },
      readReceipt: async () => null,
      refund: () => Promise.resolve(false),
      saveReceipt: () => Promise.resolve(),
      search: () =>
        Promise.resolve({
          createdAfter: null,
          issues: [
            hit("ENG-4", "canceled"),
            hit("ENG-5", "started"),
            hit("ENG-6", "completed"),
          ],
          truncated: false,
        }),
    }
  );
  assert.deepEqual(checked, ["ENG-5", "ENG-6"]);
  assert.deepEqual(followed, [
    { identifier: "ENG-6", runId, stateType: "completed" },
  ]);
  assert.equal("identifier" in filed && filed.identifier, "ENG-6");
});

test("a follow-up that Linear refuses fails the filing, so nothing tells the customer it was passed on", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const { signal } = new AbortController();
  const filed = await fileTicketFor(
    scope,
    ask("It broke again."),
    signal,
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    {
      ...noLinks,
      create: () => assert.fail("the conversation already has a ticket"),
      followUp: () => Promise.reject(new Error("Linear did not create it.")),
      kind: () => Promise.resolve("case" as const),
      owns: () => Promise.resolve(true),
      readReceipt: async () => null,
      refund: () => Promise.resolve(false),
      saveReceipt: () => assert.fail("nothing was confirmed"),
      search: () =>
        Promise.resolve({
          createdAfter: null,
          issues: [hit("ENG-6", "started")],
          truncated: false,
        }),
    }
  );
  assert.ok("error" in filed);
});

const linkedTicket = (
  identifier: string,
  kind: LinkedTicket["kind"],
  stateType = "started"
): LinkedTicket => ({
  identifier,
  kind,
  stateType,
  url: `https://linear.app/acquisity/issue/${identifier}/x`,
});

const created = (identifier: string) => () =>
  Promise.resolve({
    data: {
      id: identifier,
      url: `https://linear.app/acquisity/issue/${identifier}/x`,
    },
    ok: true as const,
  });

test("a ticket linked to the chat is found without searching descriptions, and its report gets the follow-up", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const reports: { identifier: string; addition: string }[] = [];
  const filed = await fileTicketFor(
    scope,
    ask("It broke again."),
    new AbortController().signal,
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    {
      create: () => assert.fail("the chat already has a ticket"),
      followUp: () => Promise.resolve(),
      linked: (conversationId) => {
        assert.equal(conversationId, scope.conversationId);
        return Promise.resolve([
          linkedTicket("ENG-8", "case", "canceled"),
          linkedTicket("ENG-9", "case"),
        ]);
      },
      readReceipt: async () => null,
      refund: () => Promise.resolve(false),
      report: (identifier, _content, addition) => {
        reports.push({ addition: addition.text, identifier });
        return Promise.resolve(true);
      },
      saveReceipt: () => Promise.resolve(),
      search: () => assert.fail("a linked ticket needs no search"),
    }
  );
  assert.equal("identifier" in filed && filed.identifier, "ENG-9");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.identifier, "ENG-9");
  assert.match(reports[0]?.addition ?? "", BROKE_AGAIN);
});

test("a refund beside the chat's bug ticket gets its own ticket in billing's queue, linked to the same chat", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const writes: { kind: string; body: string }[] = [];
  const contents: string[] = [];
  const filed = await fileTicketFor(
    scope,
    ask("I was charged twice in November and want one charge back."),
    new AbortController().signal,
    "ffffffff-ffff-4fff-8fff-ffffffffffff",
    {
      create: (_ctx, input) => {
        writes.push({ body: input.body, kind: input.kind });
        return created("ENG-21")();
      },
      followUp: () => assert.fail("the bug ticket is not the refund's"),
      linked: () => Promise.resolve([linkedTicket("ENG-20", "case")]),
      readReceipt: async () => null,
      refund: () => Promise.resolve(true),
      report: (identifier, content) => {
        assert.equal(identifier, "ENG-21");
        contents.push(content);
        return Promise.resolve(true);
      },
      saveReceipt: () => Promise.resolve(),
      search: () =>
        Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
    }
  );
  assert.deepEqual(filed, {
    existing: false,
    identifier: "ENG-21",
    refund: true,
    url: "https://linear.app/acquisity/issue/ENG-21/x",
  });
  assert.deepEqual(writes, [
    {
      body: "I was charged twice in November and want one charge back.",
      kind: "refund",
    },
  ]);
  // The new ticket's Support report carries the verified scope.
  assert.match(contents[0] ?? "", OPENS_WITH_SCOPE);
  assert.ok(contents[0]?.includes(`- Workspace ID: ${scope.organizationId}`));
  assert.ok(
    contents[0]?.includes(`- Support conversation: ${scope.conversationId}`)
  );
});

test("a second refund ask lands on the chat's refund ticket, which is routed to billing", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const filed = await fileTicketFor(
    scope,
    ask("Any news on my refund?"),
    new AbortController().signal,
    "abababab-abab-4bab-8bab-abababababab",
    {
      create: () => assert.fail("the chat already has a refund ticket"),
      followUp: () => Promise.resolve(),
      linked: () =>
        Promise.resolve([
          linkedTicket("ENG-20", "case"),
          linkedTicket("ENG-21", "refund"),
        ]),
      readReceipt: async () => null,
      refund: () => Promise.resolve(true),
      report: () => Promise.resolve(true),
      saveReceipt: () => Promise.resolve(),
      search: () => assert.fail("a linked ticket needs no search"),
    }
  );
  assert.equal("identifier" in filed && filed.identifier, "ENG-21");
  assert.equal("refund" in filed && filed.refund, true);
});

test("a run files once: its saved receipt is returned before any refund check, and a refund files on the next message", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const bug: WidgetTicketReceipt = {
    existing: false,
    identifier: "ENG-20",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-20/x",
  };
  const filed = await fileTicketFor(
    scope,
    ask("And I want my money back for the failed month."),
    new AbortController().signal,
    "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    {
      create: () => assert.fail("the run already filed"),
      linked: () => assert.fail("the run already filed"),
      readReceipt: async () => bug,
      refund: () => assert.fail("a saved receipt is never reclassified"),
      search: () => assert.fail("the run already filed"),
    }
  );
  assert.deepEqual(filed, bug);
});

test("the refund check reads only the ask, never the earlier turns in the report", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const asked: unknown[] = [];
  await fileTicketFor(
    scope,
    {
      ...ask("The campaign stopped sending."),
      report: ["- Customer: Last month I asked for a refund."],
    },
    new AbortController().signal,
    undefined,
    {
      ...noLinks,
      create: created("ENG-31"),
      refund: (input) => {
        asked.push(input);
        return Promise.resolve(false);
      },
      search: () =>
        Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
    }
  );
  assert.deepEqual(asked, [
    { summary: "The campaign stopped sending.", title: "Support" },
  ]);
});

test("ids the customer pasted stay out of the ticket's title and body", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const sent: { body: string; title: string }[] = [];
  const pasted = "Campaign 9f8e7d6c-5b4a-4321-8fed-cba987654321 never sends";
  await fileTicketFor(
    scope,
    { ...ask(pasted), title: pasted },
    new AbortController().signal,
    undefined,
    {
      ...noLinks,
      create: (_ctx, input) => {
        sent.push(input);
        return created("ENG-32")();
      },
      refund: () => Promise.resolve(false),
      search: () =>
        Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
    }
  );
  assert.equal(
    sent[0]?.title,
    "Campaign (id in the Support report) never sends"
  );
  assert.ok(!sent[0]?.body.includes("9f8e7d6c"));
});

const feedbackReport = (message: string): WidgetTicketInput => ({
  ...ask("It named a Billing tab that isn't there."),
  entry: "problem",
  feedback: { message },
  retryKey: "problem-report:r1",
});

test("a report on another Foreman reply gets its own ticket; one on the same reply lands on that reply's ticket", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const linked = () =>
    Promise.resolve([
      { ...linkedTicket("ENG-40", "feedback"), reported: "reply-a" },
    ]);
  const creates: string[] = [];
  const deps = {
    create: (_ctx: unknown, input: { kind: string }) => {
      creates.push(input.kind);
      return created("ENG-41")();
    },
    followUp: () => Promise.resolve(),
    legacyFeedback: () => assert.fail("no earlier ticket was named"),
    linked,
    report: () => Promise.resolve(true),
    search: () => assert.fail("feedback is never found by description"),
  };
  const same = await fileTicketFor(
    scope,
    feedbackReport("reply-a"),
    new AbortController().signal,
    undefined,
    deps as never
  );
  assert.equal("identifier" in same && same.identifier, "ENG-40");
  const other = await fileTicketFor(
    scope,
    feedbackReport("reply-b"),
    new AbortController().signal,
    undefined,
    deps as never
  );
  assert.equal("identifier" in other && other.identifier, "ENG-41");
  assert.deepEqual(creates, ["feedback"]);
});

test("a report on a reply Acquisity filed before the change lands on that ticket once it checks out", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const checked: string[] = [];
  const filed = await fileTicketFor(
    scope,
    {
      ...feedbackReport("reply-a"),
      feedback: { earlier: "ENG-7", message: "reply-a" },
    },
    new AbortController().signal,
    undefined,
    {
      create: () => assert.fail("the reply already has a ticket"),
      followUp: () => Promise.resolve(),
      legacyFeedback: (identifier, conversationId, message) => {
        checked.push(`${identifier} ${conversationId} ${message}`);
        return Promise.resolve(linkedTicket("ENG-7", "feedback"));
      },
      linked: () => Promise.resolve([]),
      report: () => Promise.resolve(true),
    }
  );
  assert.equal("identifier" in filed && filed.identifier, "ENG-7");
  assert.deepEqual(checked, [`ENG-7 ${scope.conversationId} reply-a`]);
});
test("a bug report never asks the refund check, and a failed Support report still files", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const kinds: string[] = [];
  const filed = await fileTicketFor(
    scope,
    { ...ask("The campaign never sends."), entry: "bug" },
    new AbortController().signal,
    undefined,
    {
      create: (_ctx, input) => {
        kinds.push(input.kind);
        return created("ENG-30")();
      },
      ...noLinks,
      refund: () => assert.fail("a bug is never a refund"),
      report: () => Promise.resolve(false),
      search: () =>
        Promise.resolve({ createdAfter: null, issues: [], truncated: false }),
    }
  );
  assert.deepEqual(kinds, ["bug"]);
  assert.equal("identifier" in filed && filed.identifier, "ENG-30");
});
