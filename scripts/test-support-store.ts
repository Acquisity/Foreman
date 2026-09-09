/** Runs the real store SQL against a disposable, network-isolated local Postgres. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import {
  invokeProvider,
  type ProviderContext,
} from "../agent/lib/executor/dispatch.js";
import { supportAuth } from "../agent/lib/support/auth.js";
import {
  currentCase,
  finishSupportQuietly,
  openSupportInvestigation,
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
  const intercom = {
    conversation_parts: { conversation_parts: [], total_count: 0 },
    created_at: 1,
    id: retry.conversation,
    source: { author: { type: "user" }, body: "Waiting for engineering" },
    state: "snoozed",
    updated_at: 2,
  };
  const issue = {
    description: "Investigating",
    id: "ENG-TEST",
    status: "In Progress",
  };
  let incompleteComments = false;
  const comments = [{ body: "Investigating the issue", id: "comment-test" }];
  globalThis.fetch = (url, init) => {
    urls.push(String(url));
    const rpc = JSON.parse(String(init?.body));
    const code = String(rpc.params?.arguments?.code ?? "");
    let data: unknown = {};
    if (code.includes("get_conversation")) {
      data = intercom;
    } else if (code.includes("get_issue")) {
      data = issue;
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
  assert.ok(
    urls.every(
      (url) =>
        url ===
        "https://executor.acquisity.ai/mcp/toolkits/foreman-support?artifacts=false"
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
