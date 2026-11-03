import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import type { WidgetTicketReceipt } from "./widget-run-store.js";
import type { WidgetContext } from "./widget-scope.js";
import {
  appTicketContext,
  existingTicket,
  fileTicketFor,
  fileWidgetTicket,
  inRefundQueue,
} from "./widget-ticket.js";

const SUPPORT = "4534deb2-6bbc-4e30-ad38-48963f414d14";
const REFUND_LABEL = "9120e30d-e188-4972-940b-20005b7f6d03";

const reading = (
  project: string | null,
  labels: string[]
): Parameters<typeof inRefundQueue>[1] => ({
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

test("a reused ticket counts as routed to billing only in the Support project with the Refund label", async () => {
  assert.equal(
    await inRefundQueue("ENG-1", reading(SUPPORT, [REFUND_LABEL])),
    true
  );
  // Moved to a product project but still labelled Refund.
  assert.equal(
    await inRefundQueue("ENG-1", reading("other-project", [REFUND_LABEL])),
    false
  );
  assert.equal(await inRefundQueue("ENG-1", reading(SUPPORT, [])), false);
  assert.equal(
    await inRefundQueue("ENG-1", reading(null, [REFUND_LABEL])),
    false
  );
  assert.equal(
    await inRefundQueue("ENG-1", {
      client: () => Promise.resolve({ data: null, status: 500 }),
    }),
    false
  );
});

test("the reused ticket keeps the one-ticket result and carries only the verified refund routing", () => {
  const issue = {
    identifier: "ENG-1",
    url: "https://linear.app/acquisity/issue/ENG-1",
  };
  assert.deepEqual(existingTicket(issue, false), {
    existing: true,
    identifier: "ENG-1",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-1",
  });
  assert.equal(existingTicket(issue, true).refund, true);
});

test("code filing then a tool call in one run reuses the confirmed receipt despite an empty Linear search", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  let receipt: WidgetTicketReceipt | null = null;
  let writes = 0;
  let searches = 0;
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = {
    summary: "The customer asked for a person.",
    title: "Support",
  };
  const deps = {
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
    { summary: "The customer asked for a person.", title: "Support" },
    signal,
    runId,
    {
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
      { summary: "The customer asked for a person.", title: "Support" },
      controller.signal,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      {
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

// ENG-17031: Acquisity's "I found a bug" steps file the conversation's ticket in
// code, with the conversation id in its description. A later investigation with
// no receipt of its own must find and reuse it.
const acquisityBugTicket = (stateType: string) => ({
  assignee: "Aaron Fraga",
  createdAt: "2026-11-03T18:00:00.000Z",
  identifier: "ENG-900",
  labels: ["Bug", "fixy"],
  matchedPhrases: [scope.conversationId],
  parentIdentifier: null,
  state: stateType === "canceled" ? "Canceled" : "Triage",
  stateType,
  title: "Bug report: my campaign isn't working",
  url: "https://linear.app/acquisity/issue/ENG-900/bug-report",
});

const reuseDeps = (stateType: string) => {
  const calls = { creates: 0, phrases: [] as string[][] };
  const deps = {
    create: () => {
      calls.creates += 1;
      return Promise.resolve({
        data: {
          id: "ENG-901",
          url: "https://linear.app/acquisity/issue/ENG-901/support",
        },
        ok: true as const,
      });
    },
    readReceipt: () => Promise.resolve(null),
    refund: () => Promise.resolve(false),
    saveReceipt: () => Promise.resolve(),
    search: (input: { phrases: string[] }) => {
      calls.phrases.push(input.phrases);
      return Promise.resolve({
        createdAfter: null,
        issues: [acquisityBugTicket(stateType)],
        truncated: false,
      });
    },
  };
  return { calls, deps };
};

test("an investigation with no receipt reuses the bug ticket Acquisity filed for the conversation", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const { calls, deps } = reuseDeps("triage");
  const { signal } = new AbortController();
  const result = await fileWidgetTicket(
    appTicketContext(scope, signal, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    { summary: "Campaign stopped sending.", title: "Campaign" },
    deps
  );
  assert.deepEqual(result, {
    existing: true,
    identifier: "ENG-900",
    refund: false,
    url: "https://linear.app/acquisity/issue/ENG-900/bug-report",
  });
  assert.deepEqual(calls.phrases, [[scope.conversationId]]);
  assert.equal(calls.creates, 0);
});

test("a canceled Acquisity bug ticket no longer covers the conversation", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    Promise.reject(new Error("unexpected transport"))
  );
  const { calls, deps } = reuseDeps("canceled");
  const { signal } = new AbortController();
  const result = await fileWidgetTicket(
    appTicketContext(scope, signal, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    { summary: "Campaign stopped sending.", title: "Campaign" },
    deps
  );
  assert.equal(calls.creates, 1);
  assert.equal("identifier" in result && result.identifier, "ENG-901");
});
