/** Real atomic SQL against a disposable loopback database, never customer data. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import { verifiedFinContext as scope } from "../agent/lib/fin-investigation.fixture.js";
import {
  assertFinRunOwner,
  attachFinRun,
  claimFinRun,
  completeFinRun,
  readFinRun,
  reserveFinCallback,
} from "../agent/lib/fin-run-store.js";

const url = new URL(process.env.FIN_TEST_DATABASE_URL ?? "invalid:");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/foreman_fin_test") {
  throw new Error("Requires disposable loopback foreman_fin_test.");
}
const pool = new pg.Pool({
  connectionString: url.toString(),
  connectionTimeoutMillis: 5000,
  query_timeout: 15_000,
});
neonConfig.fetchFunction = async (
  _url: RequestInfo | URL,
  options?: RequestInit
) => {
  const request = JSON.parse(String(options?.body));
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
process.env.FOREMAN_MEMORY_DATABASE_URL = "postgresql://test@fin.invalid/test";
try {
  await pool.query(
    await readFile(
      new URL("../migrations/0007_fin_investigation_runs.sql", import.meta.url),
      "utf8"
    )
  );
  const starts = await Promise.all(
    Array.from({ length: 12 }, () =>
      claimFinRun(
        scope,
        "message-1",
        "https://api.intercom.io/hooks/procedures/callback/one"
      )
    )
  );
  assert.equal(starts.filter((x) => x.fresh).length, 1);
  assert.equal(new Set(starts.map((x) => x.run.id)).size, 1);
  const first = starts[0].run;
  const concurrentScope = { ...scope, conversationId: "999" };
  const second = await claimFinRun(
    concurrentScope,
    "message-1",
    "https://api.intercom.io/hooks/procedures/callback/two"
  );
  assert.equal(second.fresh, true);
  assert.notEqual(first.id, second.run.id);
  await attachFinRun(first.id, "session-1", null);
  await assert.rejects(attachFinRun(first.id, "another-session", null));
  const duplicate = await claimFinRun(
    scope,
    "message-2",
    "https://api.intercom.io/hooks/procedures/callback/swapped"
  );
  assert.equal(duplicate.fresh, false);
  assert.equal(duplicate.run.callback_url, first.callback_url);
  const outcome = {
    message: "Confirmed ticket ENG-12345; still open.",
    status: "completed" as const,
  };
  await completeFinRun(second.run.id, {
    message: "Second finishes first",
    status: "completed",
  });
  await completeFinRun(first.id, outcome);
  await completeFinRun(first.id, { message: "stale event", status: "failed" });
  assert.deepEqual((await readFinRun(first.id)).outcome, outcome);
  assert.equal((await claimFinRun(scope, "message-1", "")).fresh, false);
  assert.equal((await claimFinRun(scope, "message-3", "")).fresh, true);
  assert.equal(
    (await readFinRun(second.run.id)).outcome?.message,
    "Second finishes first"
  );
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () => reserveFinCallback(first.id))
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.doesNotThrow(() =>
    assertFinRunOwner(first, scope, first.created_at.getTime() + 11 * 60_000)
  );
  assert.throws(() =>
    assertFinRunOwner(first, scope, first.created_at.getTime() + 60 * 60_000)
  );
  assert.throws(() => assertFinRunOwner(first, concurrentScope));
  console.log(
    "Passed: 12 racing starts, independent conversations, callback immutability, out-of-order completion, replay, completed-slot reuse with open ticket, single signal attempt, 11-minute validity, expiry and swapped conversation."
  );
} finally {
  await pool.end();
}
