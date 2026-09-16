import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFinCaseSource,
  type FinCaseFiling,
  type FinCaseOutcome,
  finCaseSource,
} from "./fin-case.js";
import { type FinLinearCall, fileFinCase } from "./fin-case-filing.js";
import { receiveFinCaseStatus } from "./fin-case-route.js";
import type { FinCase } from "./fin-case-store.js";
import { verifiedFinContext as scope } from "./fin-investigation.fixture.js";

const decision: FinCaseFiling = {
  action: "file",
  assignee: "Aaron Fraga",
  classification: "Not settled",
  customerSummary: "Calendar report",
  priority: 4,
  project: "Support",
  summary: "Test fixture only. Symptoms, evidence, uncertainty and next step.",
  title: "[TEST] Calendar report",
};
const caseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issueId = "ENG-99999";
function fixture() {
  const record: FinCase = {
    created_at: new Date("2020-01-01"),
    created_here: false,
    creation_attempted: false,
    decision,
    document_attempted: false,
    id: caseId,
    issue_id: null,
    outcome: null,
    scope,
  };
  let claimed = false;
  let issue: Record<string, unknown> | undefined;
  let document = "";
  let issueWrites = 0;
  let documentWrites = 0;
  let uncertainIssue = false;
  let uncertainDocument = false;
  let normalizedDocument = false;
  const persistence = {
    bind: (_id: string, id: string, createdHere: boolean) => {
      record.issue_id = id;
      record.created_here = createdHere;
      return Promise.resolve(record);
    },
    claim: () => {
      const fresh = !claimed;
      claimed = true;
      return Promise.resolve({ fresh, record });
    },
    finish: (_id: string, outcome: FinCaseOutcome) => {
      record.outcome ??= outcome;
      return Promise.resolve(record.outcome);
    },
    reserveCreation: () => {
      const fresh = !record.creation_attempted;
      record.creation_attempted = true;
      return Promise.resolve(fresh);
    },
    reserveDocument: () => {
      const fresh = !record.document_attempted;
      record.document_attempted = true;
      return Promise.resolve(fresh);
    },
    sourceIssue: () => Promise.resolve(null as string | null),
  };
  const call: FinLinearCall = (operation, input) =>
    Promise.resolve().then(() => {
      switch (operation) {
        case "list_issues":
          assert.equal(input.query, scope.conversationId);
          return { hasNextPage: false, issues: issue ? [{ id: issueId }] : [] };
        case "save_issue":
          issueWrites += 1;
          issue = {
            ...input,
            attachments: input.links,
            documents: [],
            id: issueId,
            priority: { value: input.priority },
            statusType: "unstarted",
            url: `https://linear.app/acquisity/issue/${issueId}/test`,
          };
          if (uncertainIssue) {
            throw new Error("Accepted but response lost");
          }
          return { id: issueId };
        case "get_issue":
          return issue;
        case "save_document":
          documentWrites += 1;
          document = String(input.content);
          if (normalizedDocument) {
            document = document.replace(
              finCaseSource(scope),
              `[${finCaseSource(scope)}](<${finCaseSource(scope)}>)`
            );
          }
          if (issue) {
            issue.documents = [{ id: "doc-1", title: "Triage investigation" }];
          }
          if (uncertainDocument) {
            throw new Error("Accepted but response lost");
          }
          return {};
        case "get_document":
          return {
            content: [
              { text: JSON.stringify({ content: document }), type: "text" },
            ],
          };
        default:
          throw new Error("Unexpected operation");
      }
    });
  const file = () =>
    fileFinCase(
      scope,
      "session-1",
      decision,
      call,
      new AbortController().signal,
      persistence
    );
  return {
    call,
    counts: () => ({ documentWrites, issueWrites }),
    file,
    issue: () => issue,
    loseDocumentResponse: () => {
      uncertainDocument = true;
    },
    loseIssueResponse: () => {
      uncertainIssue = true;
    },
    normalizeDocument: () => {
      normalizedDocument = true;
    },
    persistence,
    record,
  };
}

test("confirmed filing verifies source, routing and document and replays without writes", async () => {
  const f = fixture();
  assert.equal((await f.file()).outcome, "newly-created");
  assert.equal((await f.file()).outcome, "newly-created");
  assert.deepEqual(f.counts(), { documentWrites: 1, issueWrites: 1 });
});

test("Linear link normalization preserves verified document evidence", async () => {
  const f = fixture();
  f.normalizeDocument();
  assert.equal((await f.file()).outcome, "newly-created");
  assert.deepEqual(f.counts(), { documentWrites: 1, issueWrites: 1 });
});

test("saved source reuse does not depend on search or an authored document", async () => {
  const f = fixture();
  await f.file();
  f.record.outcome = null;
  f.record.issue_id = null;
  const issue = f.issue();
  assert.ok(issue);
  issue.description = `Human report: ${finCaseSource(scope)}`;
  issue.documents = [];
  f.persistence.sourceIssue = () => Promise.resolve(issueId);
  const result = await fileFinCase(
    scope,
    "session-1",
    decision,
    (operation, input) => {
      assert.notEqual(
        operation,
        "list_issues",
        "saved association must precede search"
      );
      assert.notEqual(
        operation,
        "save_document",
        "reuse must not rewrite human reports"
      );
      return f.call(operation, input);
    },
    new AbortController().signal,
    f.persistence
  );
  assert.equal(result.outcome, "already-tracked");
  assert.deepEqual(f.counts(), { documentWrites: 1, issueWrites: 1 });
});

test("uncertain accepted issue and document writes reconcile without duplication", async () => {
  for (const kind of ["issue", "document"] as const) {
    const f = fixture();
    if (kind === "issue") {
      f.loseIssueResponse();
    } else {
      f.loseDocumentResponse();
    }
    // biome-ignore lint/performance/noAwaitInLoops: each scenario tests a sequential retry.
    assert.equal((await f.file()).outcome, "newly-created");
    assert.equal((await f.file()).outcome, "newly-created");
    assert.deepEqual(f.counts(), { documentWrites: 1, issueWrites: 1 });
  }
});

test("an unknown write that cannot be found never permits replacement creation", async () => {
  const f = fixture();
  await f.persistence.claim();
  await f.persistence.reserveCreation();
  assert.equal((await f.file()).outcome, "failed");
  assert.deepEqual(f.counts(), { documentWrites: 0, issueWrites: 0 });
});

test("not-needed makes no Linear request", async () => {
  const f = fixture();
  f.record.decision = {
    action: "not-needed",
    reason: "The question was answered.",
  };
  assert.equal((await f.file()).outcome, "not-needed");
  assert.deepEqual(f.counts(), { documentWrites: 0, issueWrites: 0 });
});

test("mismatched routing and multiple customer sources never become confirmed success", async () => {
  const f = fixture();
  f.loseIssueResponse();
  await f.file();
  f.record.outcome = null;
  const issue = f.issue();
  assert.ok(issue);
  issue.project = "Foreign project";
  assert.equal((await f.file()).outcome, "failed");
  issue.attachments = [
    { url: finCaseSource({ ...scope, conversationId: "999" }) },
  ];
  assert.throws(() => assertFinCaseSource(issue as never, scope));
  assert.equal((await f.file()).outcome, "failed");
  assert.equal(f.counts().issueWrites, 1);
});

test("status is independent of expired runs; ambiguity, revoked access and takeover fail safely", async (t) => {
  const previous = {
    enabled: process.env.FIN_INVESTIGATION_ENABLED,
    env: process.env.VERCEL_ENV,
  };
  process.env.VERCEL_ENV = "preview";
  process.env.FIN_INVESTIGATION_ENABLED = "true";
  t.after(() => {
    if (previous.env === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = previous.env;
    }
    if (previous.enabled === undefined) {
      delete process.env.FIN_INVESTIGATION_ENABLED;
    } else {
      process.env.FIN_INVESTIGATION_ENABLED = previous.enabled;
    }
  });
  const f = fixture();
  f.record.issue_id = issueId;
  let records = [f.record];
  let takeover = false;
  const access = { revoked: false };
  let reads = 0;
  const deps = {
    find: (_scope: unknown, id?: string) =>
      Promise.resolve(records.filter((record) => !id || record.id === id)),
    inspect: () =>
      Promise.resolve({ humanReplied: takeover, requestKey: "irrelevant" }),
    read: () => {
      reads += 1;
      return Promise.resolve({ state: "completed" as const });
    },
    verify: ({ conversationId }: { conversationId: string }) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: access changes between awaited requests.
      if (access.revoked) {
        throw new Error("Revoked");
      }
      return Promise.resolve({ ...scope, conversationId });
    },
  };
  const request = async (input: Record<string, unknown> = {}) =>
    (
      await receiveFinCaseStatus(
        new Request("https://test/internal/fin/case", {
          body: JSON.stringify({ conversation_id: "12345", ...input }),
          headers: { authorization: "Bearer token" },
          method: "POST",
        }),
        deps
      )
    ).json();
  const result = await request();
  assert.equal(result.status, "current");
  assert.equal(result.ticket_status, "completed");
  assert.equal(
    result.message,
    "The ticket is marked done. This alone does not confirm deployment or resolution for your workspace."
  );
  assert.equal(
    (await request({ previous_status: "completed" })).status,
    "unchanged"
  );
  // Intercom renders uncollected optional text inputs as empty strings.
  assert.equal(
    (await request({ case_reference: "", previous_status: "" })).status,
    "current"
  );
  assert.equal(
    (await request({ case_reference: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))
      .status,
    "unavailable"
  );
  assert.equal((await request({ issue_id: "ENG-1" })).status, "unavailable");
  records = [
    f.record,
    {
      ...f.record,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      issue_id: "ENG-99998",
    },
  ];
  assert.equal((await request()).status, "clarification");
  assert.equal(reads, 3);
  access.revoked = true;
  assert.equal((await request()).status, "unavailable");
  access.revoked = false;
  takeover = true;
  assert.equal((await request()).status, "suppressed");
  assert.equal(reads, 3);
});
