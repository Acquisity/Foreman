/** Runs the real store SQL against a disposable, network-isolated local Postgres. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import supportChannel from "../agent/channels/support.js";
import { evePackageUrl } from "../agent/lib/eve-dynamic-tools.js";
import {
  invokeProvider,
  type ProviderContext,
} from "../agent/lib/executor/dispatch.js";
import {
  claimFromContext,
  type SupportClaim,
  supportAuth,
} from "../agent/lib/support/auth.js";
import { runSupportSchedule } from "../agent/lib/support/dispatch.js";
import {
  SupportRefusal,
  SupportStateConflict,
} from "../agent/lib/support/errors.js";
import {
  currentCase,
  finishSupportInvestigation,
  finishSupportQuietly,
  openSupportInvestigation,
  skipHandledSupport,
} from "../agent/lib/support/investigation.js";
import {
  readLinearFollowup,
  recoverSupportIssues,
} from "../agent/lib/support/linear-followup.js";
import { readSupportIntake } from "../agent/lib/support/slack.js";
import {
  attemptSupportDelivery,
  claimHandoffs,
  completeSupportDelivery,
  completeSupportOperation,
  discardSupportReport,
  discoverHandoff,
  findSupportLease,
  queueSupportReport,
  recordMatchedSupportIssue,
  requireSupportLease,
  reserveSupportOperation,
  saveSupportCursor,
  setSupportVersion,
  settleSupport,
  settleSupportIfNoReport,
  supportCursor,
  supportOperations,
  trackSupportIssue,
} from "../agent/lib/support/store.js";
import supportDefinition from "../agent/tools/support_investigation.js";

const connectionString = process.env.SUPPORT_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "Set SUPPORT_TEST_DATABASE_URL to the disposable loopback Postgres database."
  );
}
const databaseUrl = new URL(connectionString);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname) ||
  databaseUrl.pathname !== "/foreman_support_test"
) {
  throw new Error(
    "Support tests require a local foreman_support_test database."
  );
}
const pool = new pg.Pool({
  connectionString,
  connectionTimeoutMillis: 5000,
  query_timeout: 15_000,
});
const psql = (sql: string) => pool.query(sql);
const previousFetch = neonConfig.fetchFunction;
const previousGlobalFetch = globalThis.fetch;
// Exercise production Neon call sites with real parameterized Postgres queries.
// pg supplies wire field metadata and raw rows; Neon's normal decoding remains under test.
neonConfig.fetchFunction = async (
  _url: RequestInfo | URL,
  options?: RequestInit
) => {
  const request = JSON.parse(String(options?.body)) as {
    query: string;
    params: unknown[];
  };
  const result = await pool.query({
    rowMode: "array",
    text: request.query,
    types: { getTypeParser: () => (value: string) => value },
    values: request.params,
  });
  return Response.json({
    fields: result.fields,
    rowCount: result.rowCount,
    rows: result.rows,
  });
};
process.env.FOREMAN_MEMORY_DATABASE_URL =
  "postgresql://test@support.invalid/test";
process.env.FOREMAN_SUPPORT_ENABLED = "true";

async function verifyIntakePagination() {
  const initialCursor = await supportCursor("1788959000.000000");
  const history = Array.from({ length: 1105 }, (_, index) => ({
    ts: `1788959001.${String(index).padStart(6, "0")}`,
  })).reverse();
  const historyRequest: NonNullable<Parameters<typeof readSupportIntake>[1]> = (
    _operation,
    input
  ) => {
    const remaining = history.filter(
      (message) =>
        Number(message.ts) > Number(input.oldest) &&
        (!input.latest || Number(message.ts) < Number(input.latest))
    );
    return Promise.resolve({
      has_more: remaining.length > 100,
      messages: remaining.slice(0, 100),
      ok: true,
    });
  };
  const firstBatch = await readSupportIntake(initialCursor, historyRequest);
  assert.equal(
    await saveSupportCursor(initialCursor, {
      ...initialCursor,
      oldest: "1788950000.000000",
    }),
    false,
    "Even a current checkpoint cannot regress the watermark"
  );
  assert.equal(firstBatch.messages.length, 1000);
  assert.equal(
    firstBatch.checkpoint.oldest,
    initialCursor.oldest,
    "An incomplete scan must not skip its older gap"
  );
  assert.equal(
    await saveSupportCursor(initialCursor, firstBatch.checkpoint),
    true
  );
  assert.equal(
    await saveSupportCursor(initialCursor, {
      oldest: "1788959999.000000",
      scan_latest: null,
      scan_newest: null,
    }),
    false,
    "Overlapping stale scans cannot skip or regress the checkpoint"
  );
  history.unshift({ ts: "1788959002.000000" });
  const resumedCursor = await supportCursor("1788950000.000000");
  const secondBatch = await readSupportIntake(resumedCursor, historyRequest);
  assert.equal(secondBatch.messages.length, 105);
  assert.equal(secondBatch.checkpoint.oldest, "1788959001.001104");
  assert.equal(secondBatch.checkpoint.scan_latest, null);
  assert.equal(
    new Set(
      [...firstBatch.messages, ...secondBatch.messages].map(
        (message) => message.ts
      )
    ).size,
    1105
  );
  assert.equal(
    await saveSupportCursor(resumedCursor, secondBatch.checkpoint),
    true
  );
  assert.equal(
    await saveSupportCursor(initialCursor, firstBatch.checkpoint),
    false
  );
  const thirdBatch = await readSupportIntake(
    await supportCursor(initialCursor.oldest),
    historyRequest
  );
  assert.deepEqual(
    thirdBatch.messages,
    [{ ts: "1788959002.000000" }],
    "New arrivals above the frozen frontier wait for the next completed scan"
  );
}

async function verifyConcurrentLeaseAndDeliveryFences() {
  await Promise.all(
    Array.from({ length: 8 }, () =>
      discoverHandoff("123456", "1788959233.418909")
    )
  );
  assert.deepEqual(
    await claimHandoffs("intake", ["999999"]),
    [],
    "Test selection also excludes previously tracked cases"
  );
  assert.deepEqual(
    await claimHandoffs("followups"),
    [],
    "Followups leave initial investigations to intake"
  );
  const claims = (
    await Promise.all(Array.from({ length: 8 }, () => claimHandoffs("intake")))
  ).flat();
  assert.equal(
    claims.length,
    1,
    "Overlapping runs claim the notification only once"
  );
  const [claim] = claims;
  assert.ok(claim);
  assert.equal(claim.abandonedIntake, false);
  await setSupportVersion(claim, "customer-version-1");
  const reserved = await reserveSupportOperation(
    claim,
    "create-issue:customer-report"
  );
  assert.equal(reserved.fresh, true);
  await assert.rejects(() =>
    reserveSupportOperation(claim, "create-issue:customer-report")
  );
  await completeSupportOperation(claim, "create-issue:customer-report", {
    data: { id: "ENG-TEST" },
    ok: true,
  });
  assert.deepEqual(
    await reserveSupportOperation(claim, "create-issue:customer-report"),
    { fresh: false, result: { data: { id: "ENG-TEST" }, ok: true } }
  );
  await queueSupportReport(claim, "Verified findings", "report-hash");
  assert.equal(
    (await requireSupportLease(claim)).processed_version,
    null,
    "Queuing is not successful delivery"
  );
  assert.equal((await requireSupportLease(claim)).last_report_hash, null);
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => attemptSupportDelivery(claim))
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
    "Only one overlapping caller can send the outbox row"
  );
  await completeSupportDelivery(claim, "1788959999.000001");
  await assert.rejects(() => requireSupportLease(claim));
  await psql(
    "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
  );
  assert.deepEqual(
    await claimHandoffs("intake"),
    [],
    "Completed cases are excluded from intake"
  );
  const [next] = await claimHandoffs("followups");
  assert.ok(next);
  assert.notEqual(next.lease, claim.lease);
  assert.equal(
    (await requireSupportLease(next)).processed_version,
    "customer-version-1"
  );
  assert.equal(
    (await requireSupportLease(next)).last_report_hash,
    "report-hash"
  );
  await assert.rejects(() => reserveSupportOperation(claim, "stale-writer"));
  await setSupportVersion(next, "customer-version-2");
  await queueSupportReport(
    next,
    "Evidence temporarily unavailable",
    "retry-hash",
    "retry"
  );
  await attemptSupportDelivery(next);
  await completeSupportDelivery(next, "1788959999.000002");
  await psql(
    "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
  );
  const [retryClaim] = await claimHandoffs("followups");
  assert.ok(retryClaim);
  assert.equal(
    (await requireSupportLease(retryClaim)).processed_version,
    "customer-version-1",
    "Incomplete evidence remains eligible for retry"
  );
  await reserveSupportOperation(retryClaim, "rejected-write");
  await completeSupportOperation(
    retryClaim,
    "rejected-write",
    { error: { status: 403 }, ok: false },
    "failed"
  );
  const resumed = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      reserveSupportOperation(retryClaim, "rejected-write")
    )
  );
  assert.equal(
    resumed.filter((result) => result.status === "fulfilled").length,
    1,
    "Only one retry reserves a definitively rejected write"
  );
  return retryClaim;
}

const expireLease = async (claim: SupportClaim) => {
  const result = await pool.query(
    "UPDATE support_handoffs SET lease_until=now() - interval '1 second' WHERE conversation=$1 AND lease=$2",
    [claim.conversation, claim.lease]
  );
  assert.equal(
    result.rowCount,
    1,
    "The fixture expires exactly its owned lease"
  );
};

try {
  await psql(
    await readFile(
      new URL("../migrations/0003_support_handoffs.sql", import.meta.url),
      "utf8"
    )
  );
  await psql(
    await readFile(
      new URL(
        "../migrations/0004_support_linear_followups.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  await psql(
    await readFile(
      new URL(
        "../migrations/0005_support_operation_receipts.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  await psql(
    await readFile(
      new URL("../migrations/0006_support_intake_scan.sql", import.meta.url),
      "utf8"
    )
  );
  await verifyIntakePagination();
  const retry = await verifyConcurrentLeaseAndDeliveryFences();

  const urls: string[] = [];
  const slackPosts: string[] = [];
  const slackReplies: { client_msg_id: string; ts: string }[] = [];
  const slackReplyThreads: string[] = [];
  process.env.VERCEL_OIDC_TOKEN = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.test`;
  const intercom = {
    conversation_parts: { conversation_parts: [], total_count: 0 },
    created_at: 1,
    id: retry.conversation,
    source: { author: { type: "user" }, body: "Waiting for engineering" },
    state: "snoozed",
    updated_at: 2,
  };
  const issue = {
    assignee: "Engineer A",
    description: "Investigating",
    documents: [{ id: "triage-document", title: "Triage investigation" }],
    id: "ENG-TEST",
    labels: ["Bug", "intercom-sourced", "Customer reported"],
    parentId: "ENG-MASTER",
    priority: { value: 2 },
    project: "Core Platform",
    status: "In Progress",
  };
  const triageDocument = {
    content: `**Classification**: Bug\n**Review**: Approved 2026-09-10T12:00:00Z at ${"a".repeat(40)}`,
    url: "https://linear.app/acquisity/document/triage-test",
  };
  let incompleteComments = false;
  let loseSlackReceipt = false;
  let wireFailure: "initialize" | "response" | null = null;
  let writeDispatches = 0;
  const comments = [
    {
      body: `Investigating the issue. ${triageDocument.url}`,
      id: "comment-test",
    },
  ];
  globalThis.fetch = (url, init) => {
    urls.push(String(url));
    if (String(url).startsWith("https://api.vercel.com/v1/connect/token/")) {
      return Promise.resolve(
        Response.json({
          expiresAt: Date.now() + 3_600_000,
          token: "synthetic-slack-test",
        })
      );
    }
    if (String(url) === "https://slack.com/api/chat.postMessage") {
      const body = new URLSearchParams(String(init?.body));
      slackPosts.push(body.get("text") ?? "");
      if (loseSlackReceipt) {
        return Promise.reject(new Error("Synthetic lost Slack response"));
      }
      return Promise.resolve(
        Response.json({
          ok: true,
          ts: `1788959999.${String(100 + slackPosts.length).padStart(6, "0")}`,
        })
      );
    }
    if (String(url) === "https://slack.com/api/conversations.history") {
      return Promise.resolve(Response.json({ messages: [], ok: true }));
    }
    if (String(url) === "https://slack.com/api/conversations.replies") {
      const body = new URLSearchParams(String(init?.body));
      slackReplyThreads.push(body.get("ts") ?? "");
      return Promise.resolve(
        Response.json({ messages: [...slackReplies], ok: true })
      );
    }
    const rpc = JSON.parse(String(init?.body));
    const code = String(rpc.params?.arguments?.code ?? "");
    if (rpc.method === "initialize" && wireFailure === "initialize") {
      return Promise.reject(new Error("Synthetic initialization failure"));
    }
    if (code.includes("save_comment")) {
      writeDispatches += 1;
      if (wireFailure === "response") {
        return Promise.reject(new Error("Synthetic lost write response"));
      }
    }
    let data: unknown = {};
    if (code.includes("get_conversation")) {
      data = intercom;
    } else if (code.includes("get_issue")) {
      data = issue;
    } else if (code.includes("get_document")) {
      data = {
        content: [{ text: JSON.stringify(triageDocument), type: "text" }],
      };
    } else if (code.includes("list_comments")) {
      data = { comments, hasNextPage: incompleteComments };
    }
    if (rpc.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(
      Response.json({
        id: rpc.id,
        jsonrpc: "2.0",
        result:
          rpc.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : {
                structuredContent: {
                  result: { data, ok: true },
                  status: "completed",
                },
              },
      })
    );
  };
  process.env.EXECUTOR_MCP_CONNECTOR = "executor/support-test";
  const auth = supportAuth(
    {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    retry
  );
  const ctx = {
    abortSignal: AbortSignal.timeout(60_000),
    getToken: () => Promise.resolve({ token: "synthetic-support-test" }),
    session: { auth: { current: auth, initiator: auth }, id: "support-test" },
  } as unknown as ProviderContext;
  const resolveSupportTool = supportDefinition.events[
    "step.started"
  ] as unknown as (
    _event: unknown,
    context: ProviderContext
  ) => {
    execute: (input: unknown, context: ProviderContext) => Promise<unknown>;
  };

  // Run the actual channel adapter inside Eve's own callback context.
  const { ContextContainer, contextStorage } = (await import(
    new URL("./dist/src/context/container.js", evePackageUrl()).href
  )) as {
    ContextContainer: new () => {
      setVirtualContext: (key: unknown, value: unknown) => void;
    };
    contextStorage: { run: <T>(store: unknown, callback: () => T) => T };
  };
  const { SessionKey } = await import(
    new URL("./dist/src/context/keys.js", evePackageUrl()).href
  );
  const { adapter } = supportChannel as unknown as {
    adapter: Record<
      string,
      ((event: unknown, context: unknown) => Promise<void>) | undefined
    >;
  };
  const failTurn = (
    context: ProviderContext,
    persistedClaim: SupportClaim | null = claimFromContext(context)
  ) => {
    assert.ok(context.session);
    const container = new ContextContainer();
    container.setVirtualContext(SessionKey, {
      auth: context.session.auth,
      parent: context.session.parent,
      sessionId: "support-smoke-session",
    });
    const handler = adapter["turn.failed"];
    assert.ok(handler);
    return contextStorage.run(container, () =>
      handler({}, { state: { claim: persistedClaim } })
    );
  };
  const failSession = (failedClaim: SupportClaim | null) => {
    const handler = adapter["session.failed"];
    assert.ok(handler);
    // Terminal failure runs outside Eve context, using persisted channel state.
    return handler(
      { sessionId: "support-smoke-session" },
      { state: { claim: failedClaim } }
    );
  };
  process.env.FOREMAN_SUPPORT_HANDOFF_APP_ID = "ATEST";
  process.env.FOREMAN_SUPPORT_SINCE = "2026-09-09T00:00:00Z";
  const scheduledClaims: SupportClaim[] = [];
  const runIntake = async (conversation: string) => {
    process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS = conversation;
    await runSupportSchedule("intake", auth, (claimed) => {
      scheduledClaims.push(claimed);
      return Promise.resolve();
    });
  };
  async function verifyProviderJournal() {
    await invokeProvider(ctx, "intercom.org.foremanIntercom.get_conversation", {
      id: retry.conversation,
    });
    const child = {
      ...ctx,
      session: { ...ctx.session, parent: { sessionId: "support-test" } },
    } as ProviderContext;
    await invokeProvider(
      child,
      "intercom.org.foremanIntercom.get_conversation",
      {
        id: retry.conversation,
      }
    );
    await assert.rejects(() =>
      invokeProvider(child, "linear.org.workspaceLinear.save_issue", {
        title: "Should never dispatch",
      })
    );
    assert.equal(urls.length, 6);
    const writePath = "linear.org.workspaceLinear.save_comment";
    const writeInput = { body: "Synthetic comment", issueId: issue.id };
    wireFailure = "initialize";
    await assert.rejects(() =>
      invokeProvider(ctx, writePath, writeInput, "before-dispatch")
    );
    assert.equal(writeDispatches, 0);
    assert.equal(
      (await supportOperations(retry)).find(
        (row) => row.operation_key === "before-dispatch"
      )?.state,
      "failed"
    );
    wireFailure = null;
    await invokeProvider(ctx, writePath, writeInput, "before-dispatch");
    assert.equal(writeDispatches, 1, "An undispatched failure can retry once");
    wireFailure = "response";
    await assert.rejects(() =>
      invokeProvider(ctx, writePath, writeInput, "lost-response")
    );
    assert.equal(writeDispatches, 2);
    wireFailure = null;
    await assert.rejects(
      () => invokeProvider(ctx, writePath, writeInput, "lost-response"),
      SupportRefusal
    );
    assert.equal(
      writeDispatches,
      2,
      "An uncertain response never permits a duplicate write"
    );
    await completeSupportOperation(retry, "lost-response", {
      data: {},
      ok: true,
    });
    await completeSupportOperation(retry, "rejected-write", { ok: true });
  }

  async function verifyLinearFollowupsAndStaleWrites() {
    const retryRow = await requireSupportLease(retry);
    const recovered = await recoverSupportIssues(
      retry,
      retryRow,
      await supportOperations(retryRow)
    );
    const baseline = await currentCase(ctx, retry, recovered);
    const refusal = await resolveSupportTool({}, ctx).execute(
      { action: "skip-human-handled" },
      ctx
    );
    assert.deepEqual(refusal, {
      reason: "Cannot skip an unhandled or changed customer request.",
      refused: true,
    });
    await requireSupportLease(retry);
    assert.deepEqual(
      (await requireSupportLease(retry)).linear_ids,
      [issue.id],
      "A journaled creation recovers its watch registration after a crash"
    );
    await trackSupportIssue(retry, issue.id);
    assert.deepEqual((await requireSupportLease(retry)).linear_ids, [issue.id]);
    await setSupportVersion(retry, baseline.version, baseline.linear.snapshot);
    await settleSupport(retry, { processed: true });
    const recheck = async () => {
      await psql(
        "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
      );
      assert.deepEqual(
        await claimHandoffs("intake"),
        [],
        "Intake never reclaims a completed investigation"
      );
      const [claimed] = await claimHandoffs("followups");
      assert.ok(claimed);
      const nextAuth = supportAuth(
        {
          attributes: {},
          authenticator: "app",
          principalId: "eve:app",
          principalType: "runtime",
        },
        claimed
      );
      return {
        claimed,
        context: {
          ...ctx,
          session: {
            ...ctx.session,
            auth: { current: nextAuth, initiator: nextAuth },
          },
        } as ProviderContext,
      };
    };
    const unchanged = await recheck();
    assert.equal(
      (await openSupportInvestigation(unchanged.context)).investigate,
      false,
      "Unchanged Intercom and Linear finish without reading or posting Slack"
    );
    const changed = await recheck();
    issue.status = "Done";
    const changedRow = await requireSupportLease(changed.claimed);
    const progress = await currentCase(
      changed.context,
      changed.claimed,
      changedRow
    );
    assert.notEqual(
      progress.version,
      baseline.version,
      "Linear status alone triggers re-evaluation on a snoozed case"
    );
    assert.equal(progress.linear.changes.length, 1);
    incompleteComments = true;
    await assert.rejects(() => readLinearFollowup(changed.context, changedRow));
    incompleteComments = false;
    assert.deepEqual(
      (await requireSupportLease(changed.claimed)).linear_processed,
      baseline.linear.snapshot,
      "Incomplete reads never consume a change"
    );
    const stale = await finishSupportQuietly(
      changed.context,
      baseline.revision
    );
    assert.equal(
      stale.revision,
      progress.revision,
      "Silent completion also checks for new engineering changes"
    );
    await finishSupportQuietly(changed.context, progress.revision);
    const quiet = await recheck();
    assert.deepEqual(
      (await requireSupportLease(quiet.claimed)).linear_processed,
      progress.linear.snapshot
    );
    assert.equal(
      (await openSupportInvestigation(quiet.context)).investigate,
      false,
      "A reviewed non-actionable update stays quiet on the next tick"
    );
    const late = await recheck();
    await reserveSupportOperation(late.claimed, "late-receipt");
    await expireLease(late.claimed);
    const staleWrites = await Promise.allSettled([
      setSupportVersion(late.claimed, "stale"),
      queueSupportReport(late.claimed, "stale", "stale"),
      attemptSupportDelivery(late.claimed),
      discardSupportReport(late.claimed),
      completeSupportDelivery(late.claimed, "1788959999.000003"),
      settleSupport(late.claimed),
      trackSupportIssue(late.claimed, "ENG-STALE"),
      recordMatchedSupportIssue(late.claimed, "stale-match", { ok: true }),
    ]);
    assert.ok(
      staleWrites.every((result) => result.status === "rejected"),
      "Every stale state mutation refuses instead of silently succeeding"
    );
    await completeSupportOperation(late.claimed, "late-receipt", {
      data: { id: "receipt" },
      ok: true,
    });
    const receipt = await recheck();
    assert.deepEqual(
      await reserveSupportOperation(receipt.claimed, "late-receipt"),
      { fresh: false, result: { data: { id: "receipt" }, ok: true } },
      "Late provider success remains available to the next run without another write"
    );
    await assert.rejects(() =>
      completeSupportOperation(receipt.claimed, "late-receipt", { ok: false })
    );
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        trackSupportIssue(receipt.claimed, `ENG-CAP-${index}`)
      )
    );
    const fullWatch = await requireSupportLease(receipt.claimed);
    assert.equal(fullWatch.linear_ids.length, 10);
    await trackSupportIssue(receipt.claimed, issue.id);
    const capacityRefusal = (error: unknown) =>
      error instanceof SupportRefusal &&
      !(error instanceof SupportStateConflict) &&
      error.message.includes("already tracks 10 Linear issues");
    await assert.rejects(
      () => trackSupportIssue(receipt.claimed, "ENG-OVERFLOW"),
      capacityRefusal
    );
    const overflowReceipt = { data: { id: "ENG-OVERFLOW" }, ok: true };
    await reserveSupportOperation(receipt.claimed, "create-issue:overflow");
    await completeSupportOperation(
      receipt.claimed,
      "create-issue:overflow",
      overflowReceipt
    );
    const overflowOperations = await supportOperations(fullWatch);
    await assert.rejects(
      () =>
        recoverSupportIssues(receipt.claimed, fullWatch, overflowOperations),
      capacityRefusal
    );
    assert.deepEqual(
      (await requireSupportLease(receipt.claimed)).linear_ids,
      fullWatch.linear_ids,
      "Duplicate registration and overflow leave the full watch list unchanged"
    );
    assert.deepEqual(
      await reserveSupportOperation(receipt.claimed, "create-issue:overflow"),
      { fresh: false, result: overflowReceipt },
      "Capacity refusal preserves the successful receipt without replaying the write"
    );
    await expireLease(receipt.claimed);
    await assert.rejects(
      () => trackSupportIssue(receipt.claimed, "ENG-OVERFLOW"),
      SupportStateConflict,
      "An expired lease remains a state conflict even when the watch list is full"
    );
  }

  async function verifyConversationHandoffAndExpiredIntake() {
    await discoverHandoff("999001", "1788959999.000010");
    const [unfinished] = await claimHandoffs("intake", ["999001"]);
    assert.ok(unfinished);
    const unfinishedAuth = supportAuth(auth, unfinished);
    const unfinishedContext = {
      ...ctx,
      session: {
        ...ctx.session,
        auth: { current: unfinishedAuth, initiator: unfinishedAuth },
      },
    } as ProviderContext;
    intercom.id = unfinished.conversation;
    assert.deepEqual(
      await resolveSupportTool({}, unfinishedContext).execute(
        { action: "skip-human-handled" },
        unfinishedContext
      ),
      {
        reason:
          "The initial intake must post a concise Slack summary even when nothing was actioned. Use finish with a brief report explaining what was checked, the outcome and why no action was needed.",
        refused: true,
      }
    );
    const receive = supportChannel.receive as unknown as (
      input: unknown,
      context: {
        from: (address: string) => {
          send: (message: unknown, options: unknown) => Promise<unknown>;
        };
      }
    ) => Promise<unknown>;
    await receive(
      { auth: unfinishedAuth, message: "Synthetic intake" },
      {
        from: (address) => ({
          send: (message, options) => {
            assert.equal(
              address,
              `${unfinished.conversation}:${unfinished.thread}:${unfinished.lease}`
            );
            assert.equal(message, "Synthetic intake");
            assert.deepEqual(options, {
              auth: unfinishedAuth,
              mode: "conversation",
              state: {
                claim: {
                  conversation: unfinished.conversation,
                  lease: unfinished.lease,
                  thread: unfinished.thread,
                },
              },
              turnPolicy: "queue",
            });
            return Promise.resolve();
          },
        }),
      }
    );
    const postsBeforeCompletion = slackPosts.length;
    assert.equal(adapter["turn.completed"], undefined);
    assert.ok(await findSupportLease(unfinished));
    await runIntake(unfinished.conversation);
    assert.equal(slackPosts.length, postsBeforeCompletion);
    assert.equal(scheduledClaims.length, 0, "A live lease is not reclaimed");
    await expireLease(unfinished);
    await runIntake(unfinished.conversation);
    assert.equal(
      slackPosts.length,
      postsBeforeCompletion + 1,
      "An unfinished first intake posts its incomplete status only after lease expiry"
    );
    assert.equal(
      scheduledClaims.length,
      0,
      "Reporting leaves investigation for the next check"
    );
    await failTurn(unfinishedContext);
    await failSession(unfinished);
    assert.equal(
      slackPosts.length,
      postsBeforeCompletion + 1,
      "Late failures cannot report twice"
    );
    assert.equal(await findSupportLease(unfinished), null);
    const unfinishedState = await pool.query(
      "SELECT processed_version, report, closed FROM support_handoffs WHERE conversation=$1",
      [unfinished.conversation]
    );
    assert.deepEqual(unfinishedState.rows[0], {
      closed: false,
      processed_version: null,
      report: null,
    });
  }

  async function verifyPendingOutboxReconciliation() {
    const postsBeforePending = slackPosts.length;
    await discoverHandoff("999002", "1788959999.000011");
    const [pendingFirst] = await claimHandoffs("intake", ["999002"]);
    assert.ok(pendingFirst);
    await setSupportVersion(pendingFirst, "pending-version");
    await queueSupportReport(pendingFirst, "Attempted finding", "pending-hash");
    const pendingKey = await attemptSupportDelivery(pendingFirst);
    await failSession(pendingFirst);
    assert.equal(
      (await requireSupportLease(pendingFirst)).report_key,
      pendingKey
    );
    await expireLease(pendingFirst);
    const beforePendingDispatch = scheduledClaims.length;
    await runIntake(pendingFirst.conversation);
    assert.equal(scheduledClaims.length, beforePendingDispatch + 1);
    const pending = scheduledClaims.at(-1);
    assert.ok(pending);
    assert.deepEqual(pending, {
      abandonedIntake: false,
      conversation: pendingFirst.conversation,
      lease: pending.lease,
      thread: pendingFirst.thread,
    });
    assert.notEqual(pending.lease, pendingFirst.lease);
    assert.equal(
      slackPosts.length,
      postsBeforePending,
      "Reconciliation takes precedence over a fallback notice"
    );
    assert.equal((await requireSupportLease(pending)).report_key, pendingKey);
    await assert.rejects(
      () => discardSupportReport(pending),
      SupportStateConflict
    );
    await assert.rejects(
      () => settleSupport(pending, { closed: true }),
      SupportStateConflict
    );
    assert.equal(
      (await requireSupportLease(pending)).report_key,
      pendingKey,
      "An ambiguous delivery cannot be discarded or closed before reconciliation"
    );
    intercom.id = pending.conversation;
    intercom.state = "closed";
    slackReplies.push({
      client_msg_id: pendingKey,
      ts: "1788959999.000012",
    });
    const pendingAuth = supportAuth(auth, pending);
    assert.deepEqual(
      await openSupportInvestigation({
        ...ctx,
        session: {
          ...ctx.session,
          auth: { current: pendingAuth, initiator: pendingAuth },
        },
      } as ProviderContext),
      {
        investigate: false,
        reason:
          "Prior delivery reconciled; a later run will check new content.",
      }
    );
    assert.deepEqual(slackReplyThreads, [pending.thread]);
    slackReplies.length = 0;
    assert.equal(
      slackPosts.length,
      postsBeforePending,
      "Reconciliation finds the prior delivery without posting again"
    );
    const reconciled = await pool.query(
      "SELECT closed, report, report_key, posted_ts, lease, delivery_attempted, processed_version, last_report_hash FROM support_handoffs WHERE conversation=$1",
      [pending.conversation]
    );
    assert.deepEqual(reconciled.rows[0], {
      closed: true,
      delivery_attempted: false,
      last_report_hash: "pending-hash",
      lease: null,
      posted_ts: "1788959999.000012",
      processed_version: "pending-version",
      report: null,
      report_key: null,
    });
    await discoverHandoff("999003", "1788959999.000013");
    const [deliveredEarlier] = await claimHandoffs("intake", ["999003"]);
    assert.ok(deliveredEarlier);
    await pool.query(
      "UPDATE support_handoffs SET delivery_attempted=true WHERE conversation=$1",
      [deliveredEarlier.conversation]
    );
    await discardSupportReport(deliveredEarlier);
    await settleSupport(deliveredEarlier, { closed: true });
    const legacyDelivery = await pool.query(
      "SELECT closed, delivery_attempted FROM support_handoffs WHERE conversation=$1",
      [deliveredEarlier.conversation]
    );
    assert.deepEqual(
      legacyDelivery.rows[0],
      { closed: true, delivery_attempted: false },
      "A legacy completed delivery with no outbox can still close"
    );
  }

  async function verifyInitialReportAndQuietFollowups() {
    await discoverHandoff("999004", "1788959999.000014");
    const [initial] = await claimHandoffs("intake", ["999004"]);
    assert.ok(initial);
    intercom.id = initial.conversation;
    intercom.state = "open";
    Object.assign(intercom.conversation_parts, {
      conversation_parts: [
        {
          author: { type: "admin" },
          body: "Handled; no additional action needed.",
          created_at: 3,
          id: "human",
          part_type: "comment",
        },
      ],
      total_count: 1,
    });
    const initialAuth = supportAuth(auth, initial);
    const initialContext = {
      ...ctx,
      session: {
        ...ctx.session,
        auth: { current: initialAuth, initiator: initialAuth },
      },
    } as ProviderContext;
    const observed = await currentCase(
      initialContext,
      initial,
      await requireSupportLease(initial)
    );
    await setSupportVersion(
      initial,
      observed.version,
      observed.linear.snapshot
    );
    await assert.rejects(
      () => skipHandledSupport(initialContext),
      SupportRefusal
    );
    const beforeInitial = slackPosts.length;
    await finishSupportInvestigation(
      initialContext,
      {
        retry: false,
        summary:
          "The teammate already verified the workaround in ENG-13602.\n\nNo additional action needed.",
      },
      observed.revision
    );
    assert.equal(
      slackPosts.length,
      beforeInitial + 1,
      "Human-handled initial intake still posts a summary"
    );
    assert.ok(
      slackPosts
        .at(-1)
        ?.includes("<https://linear.app/acquisity/issue/ENG-13602|ENG-13602>")
    );
    await pool.query(
      "UPDATE support_handoffs SET next_check=now() WHERE conversation=$1",
      [initial.conversation]
    );
    const [followup] = await claimHandoffs("followups", [initial.conversation]);
    assert.ok(followup);
    const followupAuth = supportAuth(auth, followup);
    await openSupportInvestigation({
      ...ctx,
      session: {
        ...ctx.session,
        auth: { current: followupAuth, initiator: followupAuth },
      },
    } as ProviderContext);
    assert.equal(
      slackPosts.length,
      beforeInitial + 1,
      "Unchanged later follow-up remains quiet"
    );
    // Expired follow-up claims retain the ordinary quiet/reconciliation path.
    await pool.query(
      "UPDATE support_handoffs SET next_check=now() WHERE conversation=$1",
      [initial.conversation]
    );
    const [expiredFollowup] = await claimHandoffs("followups", [
      initial.conversation,
    ]);
    assert.ok(expiredFollowup);
    await expireLease(expiredFollowup);
    process.env.FOREMAN_SUPPORT_FOLLOWUPS_ENABLED = "true";
    process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS = initial.conversation;
    const beforeFollowupDispatch = scheduledClaims.length;
    const followupResults: Awaited<
      ReturnType<typeof openSupportInvestigation>
    >[] = [];
    await runSupportSchedule("followups", auth, async (claimed, nextAuth) => {
      scheduledClaims.push(claimed);
      followupResults.push(
        await openSupportInvestigation({
          ...ctx,
          session: {
            ...ctx.session,
            auth: { current: nextAuth, initiator: nextAuth },
          },
        } as ProviderContext)
      );
    });
    assert.equal(scheduledClaims.length, beforeFollowupDispatch + 1);
    const reclaimedFollowup = scheduledClaims.at(-1);
    assert.ok(reclaimedFollowup);
    assert.equal(reclaimedFollowup.conversation, expiredFollowup.conversation);
    assert.notEqual(reclaimedFollowup.lease, expiredFollowup.lease);
    assert.deepEqual(followupResults, [
      { investigate: false, reason: "No new actionable case evidence." },
    ]);
    assert.equal(slackPosts.length, beforeInitial + 1);
    assert.equal(await findSupportLease(reclaimedFollowup), null);
    const quietFollowupState = await pool.query(
      "SELECT lease, lease_until, report, closed, processed_version, next_check > now() AS deferred FROM support_handoffs WHERE conversation=$1",
      [reclaimedFollowup.conversation]
    );
    assert.deepEqual(quietFollowupState.rows[0], {
      closed: false,
      deferred: true,
      lease: null,
      lease_until: null,
      processed_version: observed.version,
      report: null,
    });

    // An unfinished follow-up retries only after its own lease expires.
    await pool.query(
      "UPDATE support_handoffs SET next_check=now() WHERE conversation=$1",
      [initial.conversation]
    );
    const beforeIdleDispatch = scheduledClaims.length;
    const dispatchIdleFollowup = () =>
      runSupportSchedule("followups", auth, (claimed) => {
        scheduledClaims.push(claimed);
        return Promise.resolve();
      });
    await dispatchIdleFollowup();
    assert.equal(scheduledClaims.length, beforeIdleDispatch + 1);
    const parked = scheduledClaims.at(-1);
    assert.ok(parked);
    assert.ok(await findSupportLease(parked));
    await dispatchIdleFollowup();
    assert.equal(scheduledClaims.length, beforeIdleDispatch + 1);
    await expireLease(parked);
    await dispatchIdleFollowup();
    assert.equal(scheduledClaims.length, beforeIdleDispatch + 2);
    const retried = scheduledClaims.at(-1);
    assert.ok(retried);
    assert.equal(retried.conversation, parked.conversation);
    assert.notEqual(retried.lease, parked.lease);
    const parkedAgain = await requireSupportLease(retried);
    assert.equal(parkedAgain.processed_version, observed.version);
    assert.equal(parkedAgain.report, null);
    assert.equal(slackPosts.length, beforeInitial + 1);
    await dispatchIdleFollowup();
    assert.equal(scheduledClaims.length, beforeIdleDispatch + 2);
    assert.ok(await findSupportLease(retried));
  }

  async function verifyFailureOwnershipAndRetries() {
    // Native child failures must return to the root, never settle its active lease.
    await discoverHandoff("999010", "1788959999.000020");
    const [rootFailure] = await claimHandoffs("intake", ["999010"]);
    assert.ok(rootFailure);
    const failureAuth = supportAuth(auth, rootFailure);
    const failureContext = {
      ...ctx,
      session: {
        ...ctx.session,
        auth: { current: failureAuth, initiator: failureAuth },
      },
    } as ProviderContext;
    const beforeFailure = slackPosts.length;
    await failTurn({
      ...failureContext,
      session: {
        ...failureContext.session,
        parent: { sessionId: "support-smoke-session" },
      },
    } as ProviderContext);
    await failSession(null);
    assert.equal(slackPosts.length, beforeFailure);
    assert.ok(await findSupportLease(rootFailure));
    assert.notEqual(claimFromContext(ctx)?.lease, rootFailure.lease);
    await failTurn(ctx, rootFailure);
    assert.equal(slackPosts.length, beforeFailure + 1);
    assert.equal(await findSupportLease(rootFailure), null);
    await failSession(rootFailure);
    assert.equal(slackPosts.length, beforeFailure + 1);

    await discoverHandoff("999011", "1788959999.000021");
    const [terminalFailure] = await claimHandoffs("intake", ["999011"]);
    assert.ok(terminalFailure);
    await failSession(terminalFailure);
    assert.equal(slackPosts.length, beforeFailure + 2);
    assert.equal(await findSupportLease(terminalFailure), null);

    // The next fresh claim resumes investigation; repeated incomplete runs do not spam.
    await pool.query(
      "UPDATE support_handoffs SET next_check=now() WHERE conversation=$1",
      [terminalFailure.conversation]
    );
    const beforeRetry = scheduledClaims.length;
    await runIntake(terminalFailure.conversation);
    const restarted = scheduledClaims.at(-1);
    assert.ok(restarted);
    assert.equal(scheduledClaims.length, beforeRetry + 1);
    assert.equal(restarted.conversation, terminalFailure.conversation);
    await expireLease(restarted);
    await runIntake(restarted.conversation);
    assert.equal(slackPosts.length, beforeFailure + 2);
    assert.equal(await findSupportLease(restarted), null);

    await discoverHandoff("999012", "1788959999.000022");
    const [ambiguousFailure] = await claimHandoffs("intake", ["999012"]);
    assert.ok(ambiguousFailure);
    await expireLease(ambiguousFailure);
    loseSlackReceipt = true;
    await runIntake(ambiguousFailure.conversation);
    loseSlackReceipt = false;
    const uncertainFailure = await pool.query(
      "SELECT lease, report, delivery_attempted FROM support_handoffs WHERE conversation=$1",
      [ambiguousFailure.conversation]
    );
    assert.ok(uncertainFailure.rows[0].lease);
    assert.ok(uncertainFailure.rows[0].report);
    assert.equal(
      uncertainFailure.rows[0].delivery_attempted,
      true,
      "A lost fallback receipt keeps its outbox and lease for reconciliation"
    );
  }

  async function verifyClosedAndSnoozedIntake() {
    for (const [id, state, thread] of [
      ["999005", "closed", "1788959999.000015"],
      ["999006", "snoozed", "1788959999.000016"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each fixture exercises a complete sequential intake.
      await discoverHandoff(id, thread);
      const [first] = await claimHandoffs("intake", [id]);
      assert.ok(first);
      intercom.id = id;
      intercom.state = state;
      const firstAuth = supportAuth(auth, first);
      const before = slackPosts.length;
      await openSupportInvestigation({
        ...ctx,
        session: {
          ...ctx.session,
          auth: { current: firstAuth, initiator: firstAuth },
        },
      } as ProviderContext);
      assert.equal(slackPosts.length, before + 1);
      assert.ok(slackPosts.at(-1)?.includes("No action taken."));
    }
  }

  async function verifyAtomicFailureSettlement() {
    await discoverHandoff("999020", "1788959999.000030");
    const [unreported] = await claimHandoffs("intake", ["999020"]);
    assert.ok(unreported);
    assert.equal(unreported.abandonedIntake, false);
    process.env.FOREMAN_SUPPORT_ENABLED = "false";
    assert.equal(await settleSupportIfNoReport(unreported), false);
    process.env.FOREMAN_SUPPORT_ENABLED = "true";
    assert.ok(await findSupportLease(unreported));
    await queueSupportReport(unreported, "Pending delivery", "atomic-hash");
    assert.equal(await settleSupportIfNoReport(unreported), false);
    assert.equal(
      (await requireSupportLease(unreported)).report,
      "Pending delivery"
    );
    await discardSupportReport(unreported);
    await expireLease(unreported);
    assert.equal(await settleSupportIfNoReport(unreported), false);
    const [reclaimed] = await claimHandoffs("intake", [
      unreported.conversation,
    ]);
    assert.ok(reclaimed);
    assert.equal(reclaimed.abandonedIntake, true);
    assert.notEqual(reclaimed.lease, unreported.lease);
    assert.equal(await settleSupportIfNoReport(unreported), false);
    assert.ok(await findSupportLease(reclaimed));
    assert.equal(await settleSupportIfNoReport(reclaimed), true);
    assert.equal(await findSupportLease(reclaimed), null);
  }

  await verifyProviderJournal();
  await verifyLinearFollowupsAndStaleWrites();
  await verifyConversationHandoffAndExpiredIntake();
  await verifyPendingOutboxReconciliation();
  await verifyInitialReportAndQuietFollowups();
  await verifyFailureOwnershipAndRetries();
  await verifyClosedAndSnoozedIntake();
  await verifyAtomicFailureSettlement();

  assert.ok(
    urls.every(
      (url) =>
        url ===
          "https://executor.acquisity.ai/mcp/toolkits/foreman-support?artifacts=false" ||
        url === "https://slack.com/api/chat.postMessage" ||
        url === "https://slack.com/api/conversations.history" ||
        url === "https://slack.com/api/conversations.replies" ||
        url.startsWith("https://api.vercel.com/v1/connect/token/")
    )
  );
  console.log(
    "PASS: PostgreSQL 18 migrations, lease reclamation, delayed first-intake notices, failure cleanup, uncertain outboxes, linked Linear recovery and quiet follow-ups."
  );
} finally {
  neonConfig.fetchFunction = previousFetch;
  globalThis.fetch = previousGlobalFetch;
  await pool.end();
}
