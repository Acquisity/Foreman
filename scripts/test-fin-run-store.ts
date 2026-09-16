/** Real atomic SQL against a disposable loopback database, never customer data. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import {
  bindFinCase,
  claimFinCase,
  findFinCases,
  finishFinCase,
  reserveFinCaseCreation,
  reserveFinCaseDocument,
} from "../agent/lib/fin-case-store.js";
import { verifiedFinContext as scope } from "../agent/lib/fin-investigation.fixture.js";
import {
  assertFinRunOwner,
  attachFinRun,
  claimFinRun,
  completeFinRun,
  FIN_RESULT_WINDOW_MS,
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
let completeBeforeRead: string | undefined;
neonConfig.fetchFunction = async (
  _url: RequestInfo | URL,
  options?: RequestInit
) => {
  const request = JSON.parse(String(options?.body));
  if (
    completeBeforeRead &&
    request.query.startsWith(
      "SELECT * FROM fin_investigation_runs WHERE app_id"
    )
  ) {
    await pool.query(
      "UPDATE fin_investigation_runs SET completed_at = now() WHERE id = $1",
      [completeBeforeRead]
    );
    completeBeforeRead = undefined;
  }
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
  await pool.query(
    await readFile(
      new URL("../migrations/0008_fin_cases.sql", import.meta.url),
      "utf8"
    )
  );
  await pool.query(
    await readFile(
      new URL(
        "../migrations/0009_fin_case_creation_owner.sql",
        import.meta.url
      ),
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
  const decision = {
    action: "file" as const,
    assignee: "Aaron Fraga" as const,
    classification: "Not settled" as const,
    customerSummary: "Test report",
    priority: 4,
    project: "Support",
    summary: "Synthetic evidence",
    title: "Test only",
  };
  const cases = await Promise.all(
    Array.from({ length: 12 }, () => claimFinCase(scope, "session-1", decision))
  );
  assert.equal(cases.filter((entry) => entry.fresh).length, 1);
  assert.equal(
    (
      await Promise.all(cases.map(() => reserveFinCaseCreation(first.id)))
    ).filter(Boolean).length,
    1
  );
  assert.equal(
    (
      await Promise.all(cases.map(() => reserveFinCaseDocument(first.id)))
    ).filter(Boolean).length,
    1
  );
  await bindFinCase(first.id, "ENG-12345", true);
  const ticket = {
    identifier: "ENG-12345",
    message: "Test ticket confirmed.",
    outcome: "newly-created" as const,
  };
  await finishFinCase(first.id, ticket);
  assert.equal(
    (await findFinCases({ ...scope, conversationId: "123" })).length,
    1
  );
  assert.equal(
    (
      await findFinCases({
        ...scope,
        userId: "33333333-3333-4333-8333-333333333333",
      })
    ).length,
    0
  );
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
    ticket,
  };
  await completeFinRun(
    second.run.id,
    {
      message: "Second finishes first",
      status: "completed",
    },
    "session-2"
  );
  await assert.rejects(completeFinRun(first.id, outcome, "foreign-session"));
  assert.equal((await readFinRun(first.id)).outcome, null);
  await completeFinRun(first.id, outcome, "session-1");
  await completeFinRun(
    first.id,
    { message: "stale event", status: "failed" },
    "session-1"
  );
  await assert.rejects(completeFinRun(first.id, outcome, "foreign-session"));
  assert.equal((await readFinRun(second.run.id)).session_id, "session-2");
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
    assertFinRunOwner(
      first,
      scope,
      first.created_at.getTime() + FIN_RESULT_WINDOW_MS
    )
  );
  assert.doesNotThrow(() =>
    assertFinRunOwner(first, scope, first.created_at.getTime() + 61 * 60_000)
  );
  assert.throws(() => assertFinRunOwner(first, concurrentScope));
  await pool.query(
    "UPDATE fin_investigation_runs SET created_at = now() - interval '61 minutes' WHERE id = $1",
    [second.run.id]
  );
  assert.equal(await reserveFinCallback(second.run.id), true);
  assert.doesNotThrow(() => assertFinRunOwner(second.run, concurrentScope));
  await pool.query(
    "UPDATE fin_investigation_runs SET created_at = now() - interval '121 minutes', callback_attempts = 0 WHERE id = $1",
    [second.run.id]
  );
  assert.equal(await reserveFinCallback(second.run.id), false);
  const expired = await readFinRun(second.run.id);
  assert.throws(() => assertFinRunOwner(expired, concurrentScope));
  await assert.rejects(claimFinRun(concurrentScope, "message-1", ""));
  assert.equal(
    (await claimFinRun(concurrentScope, "message-2", "")).fresh,
    true
  );
  const raceScope = { ...scope, conversationId: "998" };
  const active = await claimFinRun(raceScope, "old-request", "");
  completeBeforeRead = active.run.id;
  const afterCompletion = await claimFinRun(raceScope, "new-request", "");
  assert.equal(afterCompletion.fresh, true);
  assert.notEqual(afterCompletion.run.id, active.run.id);
  await attachFinRun(active.run.id, "late-session", null);
  await attachFinRun(afterCompletion.run.id, "new-session", null);
  await Promise.all([
    claimFinCase(raceScope, "late-session", decision),
    claimFinCase(raceScope, "new-session", decision),
  ]);
  const creationRace = await Promise.allSettled([
    reserveFinCaseCreation(active.run.id),
    reserveFinCaseCreation(afterCompletion.run.id),
  ]);
  assert.equal(
    creationRace.filter(
      (result) => result.status === "fulfilled" && result.value
    ).length,
    1
  );
  assert.equal(
    creationRace.filter((result) => result.status === "rejected").length,
    1
  );
  console.log(
    "Passed: concurrent starts and case reservations, late-run creation exclusion, immutable completion, replay, owner isolation, callbacks and expiry."
  );
} finally {
  await pool.end();
}
