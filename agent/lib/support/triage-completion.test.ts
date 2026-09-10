import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { type TestContext, test } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { ZodError } from "zod";
import type { ProviderContext } from "../executor/dispatch.js";
import { supportAuth } from "./auth.js";
import { SupportRefusal } from "./errors.js";
import {
  currentCase,
  finishSupportInvestigation,
  skipHandledSupport,
} from "./investigation.js";
import type { SupportRow } from "./store.js";
import {
  assertTriageOutputs,
  requireCompletedSupportTriage,
} from "./triage-completion.js";

const report = {
  assignee: "Area Owner",
  documents: [{ id: "document-1", title: "Triage investigation" }],
  id: "ENG-13629",
  labels: ["intercom-sourced", "Customer reported", "Bug"],
  parentId: "ENG-13136",
  priority: { value: 2 },
  project: "Core Platform",
  status: "Todo",
};
const document = {
  content: `# Triage investigation\n**Classification**: Bug\n**Review**: Approved 2026-09-10T12:00:00Z at ${"a".repeat(40)}\n\n## Next steps\nEngineering owns the confirmed cause; Aaron can provide the customer update.`,
  url: "https://linear.app/acquisity/document/investigation-1",
};
const comments = [
  {
    body: `The failure is routed. [Triage investigation](${document.url})`,
    id: "comment-1",
  },
];
const operations = [
  {
    operation_key: "create-issue:customer-report",
    result: { data: { id: report.id }, ok: true },
    state: "done",
  },
];
const ctx = {
  abortSignal: new AbortController().signal,
  getToken: () => Promise.resolve({ token: "synthetic-test-token" }),
};

/** Exercise actual provider reads with synthetic responses; no Linear or customer writes. */
function provider(t: TestContext, issue: Record<string, unknown> = report) {
  const prior = process.env.EXECUTOR_MCP_CONNECTOR;
  process.env.EXECUTOR_MCP_CONNECTOR = "placeholder/triage-test";
  t.after(() => {
    if (prior === undefined) {
      delete process.env.EXECUTOR_MCP_CONNECTOR;
    } else {
      process.env.EXECUTOR_MCP_CONNECTOR = prior;
    }
  });
  const seen: string[] = [];
  const responses: Record<string, unknown> = {
    get_conversation: {
      conversation_parts: { conversation_parts: [], total_count: 0 },
      created_at: 1,
      id: "123456",
      source: { author: { type: "user" }, body: "The product is failing." },
      state: "open",
      updated_at: 2,
    },
    get_document: document,
    get_issue: issue,
    list_comments: { comments, hasNextPage: false },
  };
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    if (request.method === "initialize") {
      return Promise.resolve(
        Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18" },
        })
      );
    }
    const code: string = request.params.arguments.code;
    const operation = Object.keys(responses).find((name) =>
      code.includes(`.${name}`)
    );
    assert.ok(operation, `Unexpected provider call: ${code}`);
    seen.push(operation);
    return Promise.resolve(
      Response.json({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          structuredContent: {
            result: {
              data: {
                content: [
                  { text: JSON.stringify(responses[operation]), type: "text" },
                ],
              },
              ok: true,
            },
            status: "completed",
          },
        },
      })
    );
  });
  return { responses, seen };
}

test("created confirmed bug plus a tracked completed master cannot finish without triage outputs", async (t) => {
  const api = provider(t, {
    ...report,
    assignee: undefined,
    documents: [],
    labels: ["intercom-sourced", "Customer reported"],
    parentId: undefined,
    priority: undefined,
    project: undefined,
    status: "Backlog",
  });
  // Tracking the completed ENG-13136 does not produce a relation on ENG-13629.
  await assert.rejects(
    requireCompletedSupportTriage(ctx, operations),
    SupportRefusal
  );
  assert.deepEqual(api.seen, ["get_issue"]);
  api.responses.get_issue = { ...report, parentId: undefined };
  await assert.rejects(
    requireCompletedSupportTriage(ctx, operations),
    SupportRefusal
  );
  api.responses.get_issue = report;
  await requireCompletedSupportTriage(ctx, operations);
});

test("existing and new master routing pass and retry reads reuse the same report without writes", async (t) => {
  const api = provider(t);
  for (const parentId of ["ENG-13136", "ENG-13642"]) {
    api.responses.get_issue = { ...report, parentId };
    // biome-ignore lint/performance/noAwaitInLoops: each retry observes the current synthetic provider state.
    await requireCompletedSupportTriage(ctx, operations);
    await requireCompletedSupportTriage(ctx, operations);
  }
  assert.equal(api.seen.length, 12);
  assert.ok(
    api.seen.every((name) =>
      ["get_issue", "get_document", "list_comments"].includes(name)
    )
  );
});

test("missing routing fields, comment and pending review each prevent completion", () => {
  for (const change of [
    { assignee: null },
    { project: null },
    { priority: { value: 0 } },
    { labels: ["intercom-sourced", "Customer reported"] },
    { parentId: null },
    { status: "Triage" },
  ]) {
    assert.throws(
      () => assertTriageOutputs({ ...report, ...change }, document, comments),
      SupportRefusal
    );
  }
  assert.throws(
    () => assertTriageOutputs(report, document, []),
    SupportRefusal
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        report,
        {
          ...document,
          content: "**Classification**: Bug\n**Review**: Pending critic",
        },
        comments
      ),
    SupportRefusal
  );
});

test("large existing documents validate classification and review beyond the authored write limit", async (t) => {
  const api = provider(t);
  const prefix = `${"Investigation evidence. ".repeat(1000)}\n`;
  assert.ok(prefix.length > 20_000);
  api.responses.get_document = {
    ...document,
    content: prefix + document.content,
  };
  await requireCompletedSupportTriage(ctx, operations);
  api.responses.get_document = {
    ...document,
    content: `${prefix}**Classification**: Bug\n**Review**: Pending critic`,
  };
  await assert.rejects(
    requireCompletedSupportTriage(ctx, operations),
    SupportRefusal
  );
});

test("empty investigation content remains invalid", () => {
  assert.throws(
    () => assertTriageOutputs(report, { ...document, content: "" }, comments),
    ZodError
  );
});

test("review failure adjudicated once can finish, while an unfinished review cannot", () => {
  const adjudicated = {
    ...document,
    content:
      document.content.replace("Approved", "Adjudicated") +
      "\nReview failure: pivotal evidence rechecked.",
  };
  assert.doesNotThrow(() => assertTriageOutputs(report, adjudicated, comments));
});

test("unproven and urgent-human branches preserve unset routing fields", () => {
  const untouched = { status: "Backlog" };
  const unproven = {
    ...document,
    content:
      "**Classification**: Not settled\n**Review**: Not required\n## Next steps\nNeed the failing timestamp; reopen when available.",
  };
  assert.doesNotThrow(() => assertTriageOutputs(untouched, unproven, comments));
  const urgent = {
    ...document,
    content:
      "**Classification**: Bug\n**Review**: Stopped: NEEDS_HUMAN_URGENT\n## Next steps\nAaron to confirm potential data loss.",
  };
  assert.doesNotThrow(() =>
    assertTriageOutputs({ ...untouched, assignee: "Aaron Fraga" }, urgent, [
      { body: "A person is confirming the potential incident." },
    ])
  );
  assert.throws(
    () => assertTriageOutputs(untouched, urgent, comments),
    SupportRefusal
  );
});

test("non-engineering, duplicate and unknown-ownership branches keep their existing routing", () => {
  for (const classification of ["User Error", "Platform Limitation"]) {
    assert.doesNotThrow(() =>
      assertTriageOutputs(
        {
          ...report,
          labels: ["intercom-sourced", "Customer reported"],
          parentId: null,
          status: "Done",
        },
        {
          ...document,
          content: `**Classification**: ${classification}\n**Review**: Not required`,
        },
        comments
      )
    );
  }
  assert.doesNotThrow(() =>
    assertTriageOutputs(
      { ...report, assignee: "Aaron Fraga", project: null },
      document,
      comments
    )
  );
  const duplicate = {
    ...report,
    parentId: null,
    relations: { duplicateOf: { id: "ENG-13136" } },
    status: "Duplicate",
  };
  const unreviewed = {
    ...document,
    content: "**Classification**: Bug\n**Review**: Not required",
  };
  assert.doesNotThrow(() =>
    assertTriageOutputs(duplicate, unreviewed, comments)
  );
  assert.throws(
    () =>
      assertTriageOutputs(
        { ...duplicate, relations: {} },
        unreviewed,
        comments
      ),
    SupportRefusal
  );
});

test("no customer report and the existing Step 7 Support follow-up do not manufacture Bug work", async (t) => {
  const api = provider(t, {
    ...report,
    assignee: "Aaron Fraga",
    documents: [],
    labels: ["intercom-sourced", "Customer reported"],
    parentId: null,
    priority: undefined,
    project: "Support",
  });
  await requireCompletedSupportTriage(ctx, []);
  await requireCompletedSupportTriage(ctx, [
    { ...operations[0], operation_key: "create-issue:billing" },
  ]);
  assert.equal(api.seen.length, 0);
  await requireCompletedSupportTriage(ctx, operations);
  assert.deepEqual(api.seen, ["get_issue"]);
});

test("read failure does not claim completion and a later read can recover", async (t) => {
  const api = provider(t);
  api.responses.get_document = null;
  await assert.rejects(requireCompletedSupportTriage(ctx, operations));
  api.responses.get_document = document;
  await requireCompletedSupportTriage(ctx, operations);
});

test("finish refuses omitted or failed writes; a blocker retry stays unprocessed and reuses the report", async (t) => {
  const api = provider(t, { ...report, documents: [], parentId: undefined });
  const claim = {
    conversation: "123456",
    lease: "11111111-1111-4111-8111-111111111111",
    thread: "1788959233.418909",
  };
  const auth = supportAuth(
    {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    claim
  );
  const context = {
    ...ctx,
    session: { auth: { current: auth, initiator: auth }, id: "triage-test" },
  } as unknown as ProviderContext;
  const input = {
    alreadyTried: "Investigated",
    findings: "Confirmed bug; completed master candidate found.",
    issue: "Product failure",
    missingInformation: "Linear routing is temporarily unavailable.",
    nextStep: "Aaron can review the blocker; Foreman will resume triage.",
    retry: false,
  };
  const text = [
    `Issue: ${input.issue}`,
    `Already tried: ${input.alreadyTried}`,
    `Findings: ${input.findings}`,
    `Next step: ${input.nextStep}`,
    `Missing information: ${input.missingInformation}`,
  ].join("\n\n");
  const row: SupportRow = {
    conversation: claim.conversation,
    delivery_attempted: false,
    last_report_hash: createHash("sha256").update(text).digest("hex"),
    linear_ids: [report.id],
    linear_observed: {},
    linear_processed: {},
    processed_version: null,
    report: null,
    report_key: null,
    report_kind: null,
    report_revision: null,
    thread: claim.thread,
    version: null,
  };
  const journal = [...operations];
  const writes: Array<{ params: unknown[]; query: string }> = [];
  const previous = {
    database: process.env.FOREMAN_MEMORY_DATABASE_URL,
    enabled: process.env.FOREMAN_SUPPORT_ENABLED,
    fetch: neonConfig.fetchFunction,
  };
  process.env.FOREMAN_SUPPORT_ENABLED = "true";
  process.env.FOREMAN_MEMORY_DATABASE_URL =
    "postgresql://test@support.invalid/test";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    for (const [key, value] of [
      ["FOREMAN_SUPPORT_ENABLED", previous.enabled],
      ["FOREMAN_MEMORY_DATABASE_URL", previous.database],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  neonConfig.fetchFunction = (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      params: unknown[];
      query: string;
    };
    const rows = request.query.startsWith("SELECT operation_key")
      ? journal
      : [row];
    if (request.query.startsWith("UPDATE")) {
      writes.push(request);
    }
    const fields = Object.keys(rows[0]).map((name) => ({
      dataTypeID: 3802,
      name,
    }));
    return Promise.resolve(
      Response.json({
        fields,
        rowCount: rows.length,
        rows: rows.map((entry) =>
          fields.map(({ name }) =>
            JSON.stringify((entry as Record<string, unknown>)[name])
          )
        ),
      })
    );
  };
  const current = await currentCase(context, claim, row);
  row.version = current.version;
  await assert.rejects(
    finishSupportInvestigation(context, input, current.revision),
    SupportRefusal
  );
  assert.equal(writes.length, 0, "Refusal must not settle or queue a report");
  await assert.rejects(
    finishSupportInvestigation(
      context,
      { ...input, missingInformation: "", retry: true },
      current.revision
    ),
    SupportRefusal
  );
  await finishSupportInvestigation(
    context,
    { ...input, retry: true },
    current.revision
  );
  assert.equal(
    writes.at(-1)?.params[4],
    "false",
    "An unchanged blocker report remains unprocessed"
  );
  writes.length = 0;
  api.responses.get_issue = report;
  const failure = {
    ...operations[0],
    operation_key: "linear.org.workspaceLinear.save_comment:failed",
    state: "failed",
  };
  journal.push(failure);
  await assert.rejects(
    finishSupportInvestigation(context, input, current.revision),
    SupportRefusal
  );
  assert.equal(writes.length, 0);
  failure.state = "done";
  const revised = await currentCase(context, claim, row);
  const stale = await finishSupportInvestigation(
    context,
    input,
    "0".repeat(64)
  );
  assert.equal(stale.posted, false);
  assert.equal(stale.revision, revised.revision);
  writes.length = 0;
  await finishSupportInvestigation(context, input, revised.revision);
  assert.equal(writes.at(-1)?.params[4], "true");
  assert.equal(
    journal.filter(
      (entry) => entry.operation_key === "create-issue:customer-report"
    ).length,
    1
  );
  api.responses.get_issue = { ...report, documents: [] };
  api.responses.get_conversation = {
    ...(api.responses.get_conversation as object),
    admin_assignee_id: "human-1",
  };
  const handled = await currentCase(context, claim, row);
  row.version = handled.version;
  writes.length = 0;
  await assert.rejects(skipHandledSupport(context), SupportRefusal);
  assert.equal(
    writes.length,
    0,
    "A teammate taking ownership cannot conceal unfinished triage"
  );
});
