import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { executorConnection } from "./executor/connection.js";
import {
  describeProvider,
  fileFinInvestigationCase,
  invokeProvider,
} from "./executor/dispatch.js";
import { executorTransport } from "./executor/transport.js";
import { finCaseSearch } from "./fin-case.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import {
  FIN_INVESTIGATION_ISSUER,
  finInvestigationAuth,
} from "./fin-investigation-auth.js";
import { composePrompt } from "./prompts.js";
import { repositoryCapabilitiesAvailable } from "./repository-lane.js";
import { sessionLane } from "./session-lane.js";
import { supportAuth } from "./support/auth.js";
import { canUseInvestigationMemory } from "./trust.js";

const initiator = finInvestigationAuth(verifiedFinContext);
const WORKSPACE = /aaron-fragas-workspace-wMUMT/;
const IMMUTABLE = /immutable/;
const REPOSITORIES = /Repository selection and workspaces/;
const MEMORY = /Investigation memory/;
const MODEL_CONTROLS = /Model controls/;
const INVALID_SCOPE = /no valid verified scope/;
const QUALIFIED_REPORT = /qualified customer report/;
const CUSTOMER_SAFE = /Do not mention internal lanes/;
const COMPLETE_NOW = /perform that bounded action in the root turn/;
const NO_PROGRESS_PROMISE = /Do not finish with a progress update/;
const OTHER_WORKSPACE_REDIRECT =
  /cannot be checked here because it is a different workspace/;

test("customer lane keeps the verified scope and omits internal workflow instructions", () => {
  const lane = sessionLane(initiator);
  assert.equal(lane.customer, true);
  assert.equal(lane.broadExecutor, false);
  assert.equal(lane.repository, false);
  assert.equal(repositoryCapabilitiesAvailable(initiator), false);
  assert.equal(canUseInvestigationMemory(initiator), false);
  const prompt = composePrompt(lane);
  assert.match(prompt, WORKSPACE);
  assert.match(prompt, IMMUTABLE);
  assert.match(prompt, QUALIFIED_REPORT);
  assert.match(prompt, CUSTOMER_SAFE);
  assert.match(prompt, COMPLETE_NOW);
  assert.match(prompt, NO_PROGRESS_PROMISE);
  assert.match(prompt, OTHER_WORKSPACE_REDIRECT);
  assert.doesNotMatch(prompt, REPOSITORIES);
  assert.doesNotMatch(prompt, MEMORY);
  assert.doesNotMatch(prompt, MODEL_CONTROLS);
});

test("malformed customer scope remains fail-closed", () => {
  const lane = sessionLane({
    ...initiator,
    attributes: {},
    issuer: FIN_INVESTIGATION_ISSUER,
  });
  assert.equal(lane.customer, true);
  assert.equal(lane.broadExecutor, false);
  assert.equal(lane.repository, false);
  assert.match(lane.instructions, INVALID_SCOPE);
});

test("raw Executor and authored provider dispatch deny before auth or transport", async () => {
  const connection = executorConnection();
  const session = { auth: { current: initiator, initiator } };
  const approve = connection.approval;
  assert.equal(typeof approve, "function");
  const approval = (approve as (context: never) => unknown)({
    approvedTools: [],
    session,
    toolInput: {},
    toolName: "executor__execute",
  } as never);
  assert.deepEqual(approval, {
    reason:
      "Customer investigations cannot use raw Executor. Use an authored workspace-scoped evidence tool.",
    type: "denied",
  });
  const ctx = {
    abortSignal: AbortSignal.timeout(1000),
    getToken: () =>
      assert.fail("customer dispatch must not resolve credentials"),
    session,
  } as never;
  await assert.rejects(
    invokeProvider(ctx, "planetscale.org.db.read", {}),
    (error: { code?: string; dispatched?: unknown }) =>
      error.code === "customer_scope_required" && error.dispatched === false
  );
  await assert.rejects(
    invokeProvider(ctx, "linear.org.workspaceLinear.save_issue", {
      assignee: "Someone Else",
      description: "Caller-authored scope",
      team: "Engineering Team",
      title: "Unsafe",
    }),
    (error: { code?: string; dispatched?: unknown }) =>
      error.code === "customer_scope_required" && error.dispatched === false
  );
  await assert.rejects(
    describeProvider(ctx, "planetscale.org.db.read"),
    (error: { code?: string; dispatched?: unknown }) =>
      error.code === "customer_scope_required" && error.dispatched === false
  );
  // The reads are bounded by the policy, not only by their two current callers.
  await Promise.all(
    [
      ["list_issues", { limit: 100, query: "other", team: "Engineering Team" }],
      [
        "list_issues",
        { ...finCaseSearch(verifiedFinContext), query: "215475947807357" },
      ],
      ["get_issue", { id: "OPS-1" }],
      ["get_issue", { id: "ENG-13902", includeArchived: true }],
    ].map(([operation, input]) =>
      assert.rejects(
        invokeProvider(
          ctx,
          `linear.org.workspaceLinear.${operation}`,
          input as Record<string, unknown>
        ),
        (error: { code?: string; dispatched?: unknown }) =>
          error.code === "customer_scope_required" && error.dispatched === false
      )
    )
  );
});

test("the bounded Linear filing derives its target and scope from the initiator", async () => {
  const original = executorTransport.call;
  const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
  const calls: unknown[][] = [];
  const url =
    "https://linear.app/acquisity/issue/ENG-13902/inbox-fails-to-load";
  const source = `https://app.intercom.com/a/inbox/ls8uffkp/inbox/shared/all/conversation/${verifiedFinContext.conversationId}`;
  process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/fin";
  executorTransport.call = ((...args: unknown[]) => {
    calls.push(args);
    if (args[1] === "linear.org.workspaceLinear.list_issues") {
      return Promise.resolve({
        data: { hasNextPage: false, issues: [] },
        ok: true,
      });
    }
    if (args[1] === "linear.org.workspaceLinear.save_issue") {
      return Promise.resolve({ data: { id: "ENG-13902" }, ok: true });
    }
    return Promise.resolve({
      data: {
        assignee: "Anuj Bhatt",
        attachments: [{ url: source }],
        description: `Intercom source: ${source}`,
        id: "ENG-13902",
        labels: ["intercom-sourced", "Customer reported", "Bug"],
        priority: { value: 2 },
        project: "Core Platform",
        statusType: "triage",
        url,
      },
      ok: true,
    });
  }) as typeof executorTransport.call;
  let result: unknown;
  try {
    result = await fileFinInvestigationCase(
      {
        abortSignal: AbortSignal.timeout(1000),
        getToken: async () => ({ token: "test-token" }),
        session: { auth: { current: initiator, initiator } },
      } as never,
      {
        action: "file",
        assignee: "Anuj Bhatt",
        classification: "Bug",
        priority: 2,
        project: "Core Platform",
        summary: "The inbox is not loading.",
        title: "Inbox fails to load",
      }
    );
  } finally {
    executorTransport.call = original;
    if (originalConnector === undefined) {
      delete process.env.EXECUTOR_MCP_CONNECTOR;
    } else {
      process.env.EXECUTOR_MCP_CONNECTOR = originalConnector;
    }
  }
  assert.deepEqual(result, {
    identifier: "ENG-13902",
    message:
      "A ticket was opened for the team with the investigation findings.",
    outcome: "newly-created",
  });
  assert.deepEqual(
    calls.map((call) => call[1]),
    [
      "linear.org.workspaceLinear.list_issues",
      "linear.org.workspaceLinear.save_issue",
      "linear.org.workspaceLinear.get_issue",
    ]
  );
  const written = calls[1]?.[2] as { description: string; links: unknown };
  assert.ok(written.description.endsWith(`Intercom source: ${source}`));
  assert.deepEqual(written.links, [
    { title: "Intercom conversation", url: source },
  ]);
  for (const call of calls) {
    assert.deepEqual(call[3], { maxBytes: 262_144, timeoutMs: 15_000 });
  }
});

test("ordinary lane retains its prior composition", () => {
  const ordinary = sessionLane(null);
  assert.equal(ordinary.customer, false);
  assert.equal(ordinary.broadExecutor, true);
  assert.equal(ordinary.repository, true);
});

test("support lane stays distinct from customer and broad interactive lanes", () => {
  const app: SessionAuthContext = {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  };
  const support = sessionLane(
    supportAuth(app, {
      conversation: "215475947807356",
      lease: "7bd819bb-af11-49c8-b11f-4c0d608e9244",
      thread: "1750000000.000001",
    })
  );
  assert.equal(support.customer, false);
  assert.equal(support.broadExecutor, false);
  assert.equal(support.repository, false);
});
