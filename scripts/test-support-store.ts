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
import { supportAuth } from "../agent/lib/support/auth.js";
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
  const [retry] = await claimHandoffs("followups");
  assert.ok(retry);
  assert.equal(
    (await requireSupportLease(retry)).processed_version,
    "customer-version-1",
    "Incomplete evidence remains eligible for retry"
  );
  await reserveSupportOperation(retry, "rejected-write");
  await completeSupportOperation(
    retry,
    "rejected-write",
    { error: { status: 403 }, ok: false },
    "failed"
  );
  const resumed = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      reserveSupportOperation(retry, "rejected-write")
    )
  );
  assert.equal(
    resumed.filter((result) => result.status === "fulfilled").length,
    1,
    "Only one retry reserves a definitively rejected write"
  );

  const urls: string[] = [];
  const slackPosts: string[] = [];
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
      return Promise.resolve(
        Response.json({
          ok: true,
          ts: `1788959999.${String(100 + slackPosts.length).padStart(6, "0")}`,
        })
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
  await invokeProvider(ctx, "intercom.org.foremanIntercom.get_conversation", {
    id: retry.conversation,
  });
  const child = {
    ...ctx,
    session: { ...ctx.session, parent: { sessionId: "support-test" } },
  } as ProviderContext;
  await invokeProvider(child, "intercom.org.foremanIntercom.get_conversation", {
    id: retry.conversation,
  });
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
  const retryRow = await requireSupportLease(retry);
  const recovered = await recoverSupportIssues(
    retry,
    retryRow,
    await supportOperations(retryRow)
  );
  const baseline = await currentCase(ctx, retry, recovered);
  const resolveSupportTool = supportDefinition.events[
    "step.started"
  ] as unknown as (
    _event: unknown,
    context: ProviderContext
  ) => {
    execute: (input: unknown, context: ProviderContext) => Promise<unknown>;
  };
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
  const stale = await finishSupportQuietly(changed.context, baseline.revision);
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
  await psql(
    "UPDATE support_handoffs SET lease_until = now() - interval '1 minute';"
  );
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
    () => recoverSupportIssues(receipt.claimed, fullWatch, overflowOperations),
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
  await psql(
    "UPDATE support_handoffs SET lease_until = now() - interval '1 minute';"
  );
  await assert.rejects(
    () => trackSupportIssue(receipt.claimed, "ENG-OVERFLOW"),
    SupportStateConflict,
    "An expired lease remains a state conflict even when the watch list is full"
  );
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
  const completeTurn = (context: ProviderContext) => {
    assert.ok(context.session);
    const container = new ContextContainer();
    container.setVirtualContext(SessionKey, {
      auth: context.session.auth,
      sessionId: "support-smoke-session",
    });
    const handler = (
      supportChannel as unknown as {
        adapter: {
          "turn.completed": (event: unknown, context: unknown) => Promise<void>;
        };
      }
    ).adapter["turn.completed"];
    return contextStorage.run(container, () => handler({}, {}));
  };
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
  const postsBeforeCompletion = slackPosts.length;
  await completeTurn(unfinishedContext);
  assert.equal(
    slackPosts.length,
    postsBeforeCompletion + 1,
    "An unfinished initial intake posts one short incomplete status"
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

  await discoverHandoff("999002", "1788959999.000011");
  const [pending] = await claimHandoffs("intake", ["999002"]);
  assert.ok(pending);
  await setSupportVersion(pending, "pending-version");
  await queueSupportReport(pending, "Attempted finding", "pending-hash");
  const pendingKey = await attemptSupportDelivery(pending);
  const pendingAuth = supportAuth(auth, pending);
  await completeTurn({
    ...ctx,
    session: {
      ...ctx.session,
      auth: { current: pendingAuth, initiator: pendingAuth },
    },
  } as ProviderContext);
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
  await completeSupportDelivery(pending, "1788959999.000012", true);
  const reconciled = await pool.query(
    "SELECT closed, report, report_key, posted_ts, lease FROM support_handoffs WHERE conversation=$1",
    [pending.conversation]
  );
  assert.deepEqual(reconciled.rows[0], {
    closed: true,
    lease: null,
    posted_ts: "1788959999.000012",
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
  await setSupportVersion(initial, observed.version, observed.linear.snapshot);
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
  assert.ok(
    urls.every(
      (url) =>
        url ===
          "https://executor.acquisity.ai/mcp/toolkits/foreman-support?artifacts=false" ||
        url === "https://slack.com/api/chat.postMessage" ||
        url.startsWith("https://api.vercel.com/v1/connect/token/")
    )
  );
  console.log(
    "PASS: real PostgreSQL migrations, leases, outbox, linked Linear recovery, change detection, incomplete-read retry and silent follow-up completion."
  );
} finally {
  neonConfig.fetchFunction = previousFetch;
  globalThis.fetch = previousGlobalFetch;
  await pool.end();
}
