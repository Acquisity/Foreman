/** Runs the real store SQL against a disposable, network-isolated local Postgres. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import { supportAuth } from "../agent/lib/support/auth.js";
import {
  currentCase,
  finishSupportQuietly,
  openSupportInvestigation,
} from "../agent/lib/support/investigation.js";
import { readLinearFollowup } from "../agent/lib/support/linear-followup.js";
import {
  invokeProvider,
  type ProviderContext,
} from "../agent/lib/support/provider.js";
import {
  attemptSupportDelivery,
  claimHandoffs,
  completeSupportDelivery,
  completeSupportOperation,
  discoverHandoff,
  queueSupportReport,
  releaseSupport,
  requireSupportLease,
  reserveSupportOperation,
  saveSupportCursor,
  setSupportVersion,
  supportCursor,
  trackSupportIssue,
} from "../agent/lib/support/store.js";

const CONTAINER_NAME = /^codex-support-test-[a-z0-9-]+$/;
const PARAMETERS = /\$(\d+)/g;
const container = process.env.SUPPORT_TEST_POSTGRES_CONTAINER;
if (!(container && CONTAINER_NAME.test(container))) {
  throw new Error(
    "Set SUPPORT_TEST_POSTGRES_CONTAINER to a disposable codex-support-test-* container."
  );
}

function psql(sql: string): Promise<string> {
  const args = [
    "exec",
    "-i",
    container as string,
    "psql",
    "-X",
    "-q",
    "--csv",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
  ];
  const windows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(
      windows ? "wsl.exe" : "docker",
      windows ? ["-d", "Ubuntu", "--", "docker", ...args] : args,
      { timeout: 20_000, windowsHide: true }
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(error))
    );
    child.stdin.end(sql);
  });
}

function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(cell);
      cell = "";
      if (char === "\n") {
        rows.push(row);
        row = [];
      }
    } else {
      cell += char;
    }
  }
  return rows;
}

const previousFetch = neonConfig.fetchFunction;
const previousGlobalFetch = globalThis.fetch;
neonConfig.fetchFunction = async (
  _url: RequestInfo | URL,
  options?: RequestInit
) => {
  const { query, params } = JSON.parse(String(options?.body)) as {
    query: string;
    params: unknown[];
  };
  const sql = query.replace(PARAMETERS, (_match, index: string) => {
    const value = params[Number(index) - 1];
    return value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
  });
  const parsed = csv(await psql(sql));
  const [names = [], ...rows] = parsed;
  const fields = names.map((name) => ({
    dataTypeID:
      (
        {
          closed: 16,
          delivery_attempted: 16,
          linear_ids: 1009,
          linear_observed: 3802,
          linear_processed: 3802,
          result: 3802,
        } as Record<string, number>
      )[name] ?? 25,
    name,
  }));
  return Response.json({
    fields,
    rowCount: rows.length,
    rows: rows.map((row) => row.map((cell) => (cell === "" ? null : cell))),
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
  assert.equal(await supportCursor("1788959000.000000"), "1788959000.000000");
  await saveSupportCursor("1788959001.000001");
  await saveSupportCursor("1788959000.000000");
  assert.equal(await supportCursor("1788950000.000000"), "1788959001.000001");
  await Promise.all(
    Array.from({ length: 8 }, () =>
      discoverHandoff("123456", "1788959233.418909")
    )
  );
  assert.deepEqual(
    await claimHandoffs(["999999"]),
    [],
    "Test selection also excludes previously tracked cases"
  );
  const claims = (
    await Promise.all(Array.from({ length: 8 }, () => claimHandoffs()))
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
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => attemptSupportDelivery(claim))
  );
  assert.equal(
    attempts.filter(Boolean).length,
    1,
    "Only one overlapping caller can send the outbox row"
  );
  await completeSupportDelivery(claim, "1788959999.000001");
  await assert.rejects(() => requireSupportLease(claim));
  await psql(
    "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
  );
  const [next] = await claimHandoffs();
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
  await completeSupportDelivery(next, "1788959999.000002");
  await psql(
    "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
  );
  const [retry] = await claimHandoffs();
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
  const baseline = await currentCase(ctx, retry);
  assert.deepEqual(
    (await requireSupportLease(retry)).linear_ids,
    [issue.id],
    "A journaled creation recovers its watch registration after a crash"
  );
  await trackSupportIssue(retry, issue.id);
  assert.deepEqual((await requireSupportLease(retry)).linear_ids, [issue.id]);
  await setSupportVersion(retry, baseline.version, baseline.linear.snapshot);
  await releaseSupport(retry, false, true);
  const recheck = async () => {
    await psql(
      "UPDATE support_handoffs SET next_check = now() - interval '1 minute';"
    );
    const [claimed] = await claimHandoffs();
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
  const progress = await currentCase(changed.context, changed.claimed);
  assert.notEqual(
    progress.version,
    baseline.version,
    "Linear status alone triggers re-evaluation on a snoozed case"
  );
  assert.equal(progress.linear.changes.length, 1);
  incompleteComments = true;
  await assert.rejects(() =>
    readLinearFollowup(changed.context, changed.claimed)
  );
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
}
