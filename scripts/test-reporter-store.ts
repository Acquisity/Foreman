import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { disposableDatabaseUrl } from "../agent/lib/reporter-updates/disposable-database.js";
import {
  createReporterStore,
  type PendingTicket,
} from "../agent/lib/reporter-updates/store.js";

const url = disposableDatabaseUrl(process.env.REPORTER_STORE_TEST_URL);

const pool = new pg.Pool({ connectionString: url, max: 8 });
const store = createReporterStore(
  async (text, values) => (await pool.query(text, values)).rows
);

const migration = await readFile(
  join(import.meta.dirname, "..", "migrations", "0013_reporter_updates.sql"),
  "utf8"
);
await pool.query(
  "DROP TABLE IF EXISTS reporter_updates, reporter_pending, reporter_cursor"
);
await pool.query(migration);

const queued = async (issue: string): Promise<PendingTicket> => {
  const [row] = await pool
    .query(
      "SELECT seen_version::text AS version FROM reporter_pending WHERE issue = $1",
      [issue]
    )
    .then((result) => result.rows);
  return {
    issue,
    version: typeof row?.version === "string" ? Number(row.version) : null,
  };
};
const due = async (issue: string) =>
  (await store.nextPending(10)).some((ticket) => ticket.issue === issue);

const claims = await Promise.all(
  Array.from({ length: 8 }, () =>
    store.claim("ENG-1", "fixed", "Good news", "C0AAAAAAAAA")
  )
);
const winners = claims.filter((claim) => claim.ok);
assert.equal(winners.length, 1, "eight racing claims, one winner");
const [first] = winners;
assert.ok(first?.ok);
const firstToken = first.token;

assert.partialDeepStrictEqual(
  await store.claim("ENG-1", "fixed", "again", null),
  {
    ok: false,
    reason: "busy",
  }
);

await pool.query(
  "UPDATE reporter_updates SET claimed_at = now() - interval '11 minutes' WHERE issue = 'ENG-1'"
);
const second = await store.claim("ENG-1", "fixed", "retry", null);
assert.ok(second.ok, "an expired claim is taken over");

await store.release("ENG-1", "fixed", firstToken);
assert.equal(
  (await store.rows("ENG-1"))[0]?.status,
  "claimed",
  "a release with the old token changes nothing"
);
assert.equal(
  await store.complete(
    "ENG-1",
    "fixed",
    ["fixed"],
    "Good news",
    null,
    "c-old",
    firstToken
  ),
  false,
  "a completion with the old token is refused"
);
assert.equal(
  await store.complete(
    "ENG-1",
    "fixed",
    ["fixed"],
    "Good news",
    null,
    "comment-1",
    second.token
  ),
  true
);
assert.partialDeepStrictEqual(
  await store.claim("ENG-1", "fixed", "again", null),
  {
    ok: false,
    reason: "busy",
  }
);
await store.markWaiting("ENG-1", "abc1234");
assert.deepEqual(
  (await store.rows("ENG-1")).map((row) => [
    row.stage,
    row.status,
    row.commentId,
  ]),
  [["fixed", "sent", "comment-1"]],
  "markWaiting never reopens a sent row"
);

const named = await store.claim("ENG-2", "received", "Hello", null);
assert.ok(named.ok);
assert.equal(
  await store.complete(
    "ENG-2",
    "received",
    ["received", "not_fixed"],
    "Hello",
    null,
    "comment-2",
    named.token
  ),
  true
);
assert.deepEqual(
  (await store.rows("ENG-2"))
    .map((row) => row.stage)
    .sort((a, b) => a.localeCompare(b)),
  ["not_fixed", "received"]
);

await store.markWaiting("ENG-3", "sha-1");
await store.markWaiting("ENG-3", "sha-2");
assert.equal(await store.anyWaiting(), true);
assert.equal((await store.rows("ENG-3"))[0]?.checkedSha, "sha-2");
const waiting = await store.claim("ENG-3", "fixed", "msg", null);
assert.ok(waiting.ok, "a waiting row can be claimed");
await store.release("ENG-3", "fixed", waiting.token);
assert.equal(
  (await store.rows("ENG-3"))[0]?.status,
  "waiting",
  "release returns it to waiting"
);

await [1, 2, 3, 4].reduce(async (previous) => {
  await previous;
  await pool.query(
    "UPDATE reporter_updates SET retry_after = NULL WHERE issue = 'ENG-3'"
  );
  const claim = await store.claim("ENG-3", "fixed", "msg", null);
  assert.ok(claim.ok);
  await store.release("ENG-3", "fixed", claim.token);
}, Promise.resolve());
assert.partialDeepStrictEqual(
  await store.claim("ENG-3", "fixed", "msg", null),
  {
    ok: false,
    reason: "backing_off",
  },
  "a released claim waits out its backoff"
);
await pool.query(
  "UPDATE reporter_updates SET retry_after = now() - interval '1 second' WHERE issue = 'ENG-3'"
);
const afterBackoff = await store.claim("ENG-3", "fixed", "msg", null);
assert.ok(afterBackoff.ok, "and is claimable again once it has elapsed");
assert.equal(afterBackoff.attempts, 6);
await store.release("ENG-3", "fixed", afterBackoff.token);
const [waitingRow] = await pool
  .query(
    "SELECT retry_after - now() AS wait FROM reporter_updates WHERE issue = 'ENG-3'"
  )
  .then((result) => result.rows);
assert.ok(
  (waitingRow?.wait.hours ?? 0) * 60 + (waitingRow?.wait.minutes ?? 0) <= 360,
  "the wait never exceeds six hours"
);
await store.enqueue([{ issue: "ENG-3", version: 100 }]);
const reset = await store.claim("ENG-3", "fixed", "msg", null);
assert.ok(reset.ok, "new ticket activity clears the backoff");
assert.equal(reset.attempts, 1);

const fresh = await store.claim("ENG-9", "received", "msg", null);
assert.ok(fresh.ok);
await store.release("ENG-9", "received", fresh.token);
const [freshWait] = await pool
  .query(
    "SELECT extract(epoch FROM retry_after - now()) AS seconds FROM reporter_updates WHERE issue = 'ENG-9'"
  )
  .then((result) => result.rows);
assert.ok(
  Number(freshWait?.seconds) > 290 && Number(freshWait?.seconds) <= 300,
  "the fresh retry is five minutes away"
);
const blocked = await store.claim("ENG-9", "received", "msg", null);
assert.ok(!blocked.ok);
assert.ok(
  Math.abs(blocked.retryAfter - (Date.now() + 300_000)) < 10_000,
  "a refused claim says when it will be claimable"
);

await pool.query("TRUNCATE reporter_updates, reporter_pending");
await store.markWaiting("ENG-7", null);
await store.enqueue([{ issue: "ENG-7", version: 1 }]);
await pool.query(
  "UPDATE reporter_updates SET attempts = 1, retry_after = now() - interval '1 minute' WHERE issue = 'ENG-7'"
);
const raced = await Promise.all([
  store.claim("ENG-7", "fixed", "msg", null),
  store.claim("ENG-7", "fixed", "msg", null),
]);
const winner = raced.find((claim) => claim.ok);
const loser = raced.find((claim) => !claim.ok);
assert.ok(winner?.ok && loser && !loser.ok, "one racing claim wins, one loses");
assert.equal(loser.reason, "busy");
assert.ok(
  Math.abs(loser.retryAfter - (Date.now() + 600_000)) < 20_000,
  "the loser is told when the winner's claim lapses, not the stale deadline"
);
await store.release("ENG-7", "fixed", winner.token);
const [stored] = await pool
  .query(
    "SELECT extract(epoch FROM retry_after - now()) AS seconds FROM reporter_updates WHERE issue = 'ENG-7'"
  )
  .then((result) => result.rows);
assert.ok(
  Number(stored?.seconds) > 590 && Number(stored?.seconds) <= 600,
  "the winner's failure sets the second backoff"
);
await store.deferPending(await queued("ENG-7"), loser.retryAfter);
assert.equal(
  await due("ENG-7"),
  false,
  "the loser's deferral does not make the ticket due early"
);
await store.deferPending(await queued("ENG-7"), Date.now() + 60_000);
const [pendingWait] = await pool
  .query(
    "SELECT extract(epoch FROM retry_after - now()) AS seconds FROM reporter_pending WHERE issue = 'ENG-7'"
  )
  .then((result) => result.rows);
assert.ok(
  Number(pendingWait?.seconds) > 500,
  "an earlier deadline never replaces a later one"
);
await store.failPending(await queued("ENG-7"));
const [afterFail] = await pool
  .query(
    "SELECT extract(epoch FROM retry_after - now()) AS seconds FROM reporter_pending WHERE issue = 'ENG-7'"
  )
  .then((result) => result.rows);
assert.ok(
  Number(afterFail?.seconds) > 500,
  "a failure never shortens a deadline that is already further out"
);

await pool.query("TRUNCATE reporter_updates, reporter_pending");
await store.markWaiting("ENG-8", "old-sha");
await store.markSent("ENG-8", ["received"], "msg", null, "c-received");
const sentFixed = await store.claim("ENG-8", "fixed", "msg", null);
assert.ok(sentFixed.ok);
await store.enqueue([{ issue: "ENG-8", version: 1 }]);
await store.resolvePending(await queued("ENG-8"), { kind: "drop" });
assert.equal(
  (await store.rows("ENG-8")).some((row) => row.stage === "fixed"),
  true,
  "a row that is claimed is not dropped"
);
await store.complete(
  "ENG-8",
  "fixed",
  ["fixed"],
  "msg",
  null,
  "c-fixed",
  sentFixed.token
);
await store.markWaiting("ENG-10", "old-sha");
await store.enqueue([{ issue: "ENG-10", version: 1 }]);
await store.resolvePending(await queued("ENG-10"), {
  kind: "stamp",
  sha: "new-sha",
});
await store.queueWaiting("new-sha");
assert.equal(
  await due("ENG-10"),
  false,
  "a row stamped with the live commit is not requeued until the next deploy"
);
await store.queueWaiting("newer-sha");
assert.equal(
  await due("ENG-10"),
  true,
  "and is requeued once the next deploy lands"
);
await store.markWaiting("ENG-9", "old-sha");
await store.enqueue([{ issue: "ENG-9", version: 1 }]);
await store.resolvePending(await queued("ENG-9"), { kind: "drop" });
await store.queueWaiting("new-sha");
assert.equal(
  await due("ENG-9"),
  false,
  "a dropped waiting row is never requeued"
);
assert.equal(
  (await store.rows("ENG-8")).find((row) => row.stage === "fixed")?.status,
  "sent",
  "a sent row is never dropped"
);

await pool.query("TRUNCATE reporter_updates, reporter_pending");
await pool.query(
  `INSERT INTO reporter_updates (issue, stage, status, checked_sha)
   SELECT 'ENG-' || n, 'fixed', 'waiting', 'live-sha' FROM generate_series(1000, 1249) AS n`
);
await store.markWaiting("ENG-2000", null);
await store.markWaiting("ENG-2001", "older-sha");
assert.equal(await store.anyWaiting(), true);
await store.queueWaiting("live-sha");
assert.deepEqual(
  (await store.nextPending(10)).sort((a, b) => a.issue.localeCompare(b.issue)),
  [
    { issue: "ENG-2000", version: null },
    { issue: "ENG-2001", version: null },
  ],
  "rows already checked against the live commit never crowd out the others"
);

await store.enqueue([
  { issue: "ENG-2000", version: 100 },
  { issue: "ENG-5", version: 100 },
  { issue: "ENG-5", version: 90 },
]);
await store.failPending(await queued("ENG-2000"));
assert.equal(
  await due("ENG-2000"),
  false,
  "a ticket that just failed waits out its backoff"
);
assert.equal(
  await store.resolvePending(await queued("ENG-5"), { kind: "keep" }),
  true
);
assert.equal(await due("ENG-5"), false);
await Array.from({ length: 25 }, (_, i) => i).reduce(async (previous) => {
  await previous;
  await store.failPending(await queued("ENG-2001"));
}, Promise.resolve());
const [pendingRow] = await pool
  .query(
    "SELECT attempts, retry_after - now() AS wait FROM reporter_pending WHERE issue = 'ENG-2001'"
  )
  .then((result) => result.rows);
assert.equal(pendingRow?.attempts, 25);
assert.ok(
  (pendingRow?.wait.hours ?? 0) * 60 + (pendingRow?.wait.minutes ?? 0) <= 360,
  "the wait never exceeds six hours"
);
await pool.query(
  "UPDATE reporter_pending SET retry_after = now() - interval '1 second' WHERE issue = 'ENG-2001'"
);
assert.equal(
  await due("ENG-2001"),
  true,
  "a failing ticket is tried again once its backoff has passed"
);
await store.failPending(await queued("ENG-2001"));
await store.enqueue([{ issue: "ENG-2001", version: 100 }]);
assert.equal(
  await due("ENG-2001"),
  true,
  "new ticket activity brings it back at once"
);

await store.failPending(await queued("ENG-2001"));
await store.enqueue([{ issue: "ENG-2001", version: 100 }]);
assert.equal(
  await due("ENG-2001"),
  false,
  "rediscovering the same version keeps the backoff"
);
await store.enqueue([{ issue: "ENG-2001", version: 101 }]);
assert.equal(await due("ENG-2001"), true, "a newer version clears it");

await pool.query("TRUNCATE reporter_updates, reporter_pending");
await store.enqueue([{ issue: "ENG-11", version: 100 }]);
const [olderRun] = await store.nextPending(10);
assert.ok(olderRun);
assert.deepEqual(olderRun, { issue: "ENG-11", version: 100 });
await store.enqueue([{ issue: "ENG-11", version: 200 }]);
await store.failPending(olderRun);
await store.deferPending(olderRun, Date.now() + 3_600_000);
assert.equal(
  await due("ENG-11"),
  true,
  "an older run's failure or deferral does not back off a newer version"
);
assert.equal(
  await store.resolvePending(olderRun, { kind: "keep" }),
  false,
  "an older run is told its version was not the one acknowledged"
);
assert.deepEqual(
  await store.nextPending(10),
  [{ issue: "ENG-11", version: 200 }],
  "an older run's acknowledgement does not delete a newer version"
);
assert.equal(
  await store.resolvePending(
    { issue: "ENG-11", version: 200 },
    { kind: "keep" }
  ),
  true
);
assert.equal(
  await store.resolvePending(
    { issue: "ENG-11", version: 200 },
    { kind: "keep" }
  ),
  false,
  "acknowledging a row that is already gone reports nothing removed"
);
assert.equal(await due("ENG-11"), false, "the current version is acknowledged");

await store.markWaiting("ENG-12", "old-sha");
await store.queueWaiting("new-sha");
const [waitingRun] = await store.nextPending(10);
assert.ok(waitingRun);
assert.deepEqual(waitingRun, { issue: "ENG-12", version: null });
await store.enqueue([{ issue: "ENG-12", version: 300 }]);
assert.equal(await store.resolvePending(waitingRun, { kind: "drop" }), false);
assert.equal(
  (await store.rows("ENG-12"))[0]?.status,
  "waiting",
  "a stale acknowledgement does not drop the wait"
);
assert.equal(
  await store.resolvePending(waitingRun, { kind: "stamp", sha: "new-sha" }),
  false
);
assert.equal(
  (await store.rows("ENG-12"))[0]?.checkedSha,
  "old-sha",
  "or stamp it"
);
assert.deepEqual(
  await store.nextPending(10),
  [{ issue: "ENG-12", version: 300 }],
  "a deploy recheck's acknowledgement does not delete a version discovery queued meanwhile"
);
assert.equal(
  await store.resolvePending(
    { issue: "ENG-12", version: 300 },
    { kind: "drop" }
  ),
  true
);
assert.deepEqual(
  await store.rows("ENG-12"),
  [],
  "the current acknowledgement drops the wait in the same statement"
);

assert.deepEqual(await store.readCursor(), { since: null, sweep: null });
await store.saveCursor(1_760_000_000_000);
await store.saveCursor(1_750_000_000_000);
assert.equal(
  (await store.readCursor()).since,
  1_760_000_000_000,
  "the cursor never moves back"
);
const sweep = {
  after: "cursor-9",
  since: 1_750_000_000_000,
  startedAt: 1_770_000_000_000,
};
await store.saveSweep(sweep);
assert.deepEqual(await store.readCursor(), { since: 1_760_000_000_000, sweep });
await store.saveCursor(1_770_000_000_000);
assert.equal(
  (await store.readCursor()).sweep,
  null,
  "finishing a sweep clears the page cursor"
);

await assert.rejects(
  pool.query(
    "INSERT INTO reporter_updates (issue, stage, status) VALUES ('ENG-4', 'nonsense', 'sent')"
  )
);

await pool.end();
console.log("reporter store checks passed");
