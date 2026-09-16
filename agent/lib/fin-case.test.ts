import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type FinCaseDecision,
  type FinCaseFiling,
  finCaseSource,
} from "./fin-case.js";
import { type FinLinearCall, fileFinCase } from "./fin-case-filing.js";
import { verifiedFinContext as scope } from "./fin-investigation.fixture.js";

const CANCELLED = /cancelled/;

const source = finCaseSource(scope);
const filing: FinCaseFiling = {
  action: "file",
  assignee: "Anuj Bhatt",
  classification: "Bug",
  customerSummary: "The inbox does not load.",
  priority: 2,
  project: "Core Platform",
  summary: "The inbox is not loading.",
  title: "Inbox fails to load",
};

const trackedIssue = (overrides: Record<string, unknown> = {}) => ({
  assignee: "Anuj Bhatt",
  attachments: [{ url: source }],
  description: `## Customer report\n\nIntercom source: ${source}`,
  id: "ENG-13902",
  labels: ["intercom-sourced", "Customer reported", "Bug"],
  priority: { value: 2 },
  project: "Core Platform",
  statusType: "triage",
  url: "https://linear.app/acquisity/issue/ENG-13902/inbox-fails-to-load",
  ...overrides,
});

/** Record every operation so the provider call budget is part of each assertion. */
const recorder = (responses: {
  get?: unknown;
  list: unknown;
  save?: unknown;
}) => {
  const operations: string[] = [];
  const call: FinLinearCall = (operation, input) => {
    operations.push(operation);
    if (operation === "list_issues") {
      return Promise.resolve(responses.list);
    }
    if (operation === "save_issue") {
      return Promise.resolve(responses.save ?? { id: "ENG-13902" });
    }
    assert.deepEqual(input, { id: "ENG-13902" });
    return Promise.resolve(responses.get);
  };
  return { call, operations };
};

const run = (
  decision: FinCaseDecision,
  responses: Parameters<typeof recorder>[0],
  signal = new AbortController().signal
) => {
  const { call, operations } = recorder(responses);
  return fileFinCase(scope, decision, call, signal).then((outcome) => ({
    operations,
    outcome,
  }));
};

test("a not-needed decision short-circuits before any provider call", async () => {
  const { call, operations } = recorder({ list: null });
  const outcome = await fileFinCase(
    scope,
    { action: "not-needed", reason: "The customer misread the filter." },
    call,
    new AbortController().signal
  );
  assert.deepEqual(outcome, {
    message: "The customer misread the filter.",
    outcome: "not-needed",
  });
  assert.deepEqual(operations, []);
});

test("no existing match creates exactly one issue and reads it back", async () => {
  const { operations, outcome } = await run(filing, {
    get: trackedIssue(),
    list: { hasNextPage: false, issues: [] },
  });
  assert.equal(outcome.outcome, "newly-created");
  assert.equal(outcome.identifier, "ENG-13902");
  assert.deepEqual(operations, ["list_issues", "save_issue", "get_issue"]);
});

test("one existing match is reported as tracked without writing", async () => {
  const { operations, outcome } = await run(filing, {
    get: trackedIssue(),
    list: { hasNextPage: false, issues: [{ id: "ENG-13902" }] },
    save: assert.fail,
  });
  assert.deepEqual(outcome, {
    identifier: "ENG-13902",
    message:
      "This report is already tracked by the team; no new ticket was created.",
    outcome: "already-tracked",
  });
  assert.deepEqual(operations, ["list_issues", "get_issue"]);
});

test("a re-triaged existing ticket is still tracked, not a verification failure", async () => {
  const { operations, outcome } = await run(filing, {
    get: trackedIssue({
      assignee: "Koppany Kondricz",
      priority: { value: 3 },
      project: "AI SDR",
    }),
    list: { hasNextPage: false, issues: [{ id: "ENG-13902" }] },
    save: assert.fail,
  });
  assert.equal(outcome.outcome, "already-tracked");
  assert.equal(outcome.identifier, "ENG-13902");
  assert.deepEqual(operations, ["list_issues", "get_issue"]);
});

test("two matches fail rather than guess which ticket belongs here", async () => {
  const { operations, outcome } = await run(filing, {
    list: {
      hasNextPage: false,
      issues: [{ id: "ENG-13902" }, { id: "ENG-13903" }],
    },
  });
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.identifier, undefined);
  assert.deepEqual(operations, ["list_issues"]);
});

test("a truncated search page cannot prove the ticket is absent", async () => {
  const { operations, outcome } = await run(filing, {
    list: { hasNextPage: true, issues: [] },
  });
  assert.equal(outcome.outcome, "failed");
  assert.deepEqual(operations, ["list_issues"]);
});

test("a routing mismatch on the create path fails and never retries the write", async () => {
  const { operations, outcome } = await run(filing, {
    get: trackedIssue({ assignee: "Jil Patel" }),
    list: { hasNextPage: false, issues: [] },
  });
  assert.equal(outcome.outcome, "failed");
  assert.deepEqual(operations, ["list_issues", "save_issue", "get_issue"]);
});

for (const [name, overrides] of [
  [
    "another conversation in the body",
    { description: "Intercom source: none" },
  ],
  ["a missing conversation link", { attachments: [] }],
  [
    "an issue URL that names a different issue",
    { url: "https://linear.app/acquisity/issue/ENG-99/other" },
  ],
] as const) {
  test(`a source mismatch fails: ${name}`, async () => {
    const { outcome } = await run(filing, {
      get: trackedIssue(overrides),
      list: { hasNextPage: false, issues: [{ id: "ENG-13902" }] },
    });
    assert.equal(outcome.outcome, "failed");
  });
}

test("an aborted turn rethrows instead of reporting a verified outcome", async () => {
  const controller = new AbortController();
  const call: FinLinearCall = () => {
    controller.abort();
    return Promise.reject(new Error("cancelled"));
  };
  await assert.rejects(
    fileFinCase(scope, filing, call, controller.signal),
    CANCELLED
  );
});
