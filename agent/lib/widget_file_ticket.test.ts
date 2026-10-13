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
