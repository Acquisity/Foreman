import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { disposableDatabaseUrl } from "../agent/lib/reporter-updates/disposable-database.js";
import { createReporterStore } from "../agent/lib/reporter-updates/store.js";

const url = disposableDatabaseUrl(process.env.REPORTER_STORE_TEST_URL);

const pool = new pg.Pool({ connectionString: url, max: 8 });
const store = createReporterStore(
  async (text, values) => (await pool.query(text, values)).rows
);

const migration = await readFile(
  join(import.meta.dirname, "..", "migrations", "0013_reporter_updates.sql"),
  "utf8"
);
await pool.query("DROP TABLE IF EXISTS reporter_updates");
await pool.query(migration);

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

assert.deepEqual(await store.claim("ENG-1", "fixed", "again", null), {
  ok: false,
  reason: "busy",
});

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
assert.deepEqual(await store.claim("ENG-1", "fixed", "again", null), {
  ok: false,
  reason: "busy",
});
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
    ["received", "owner"],
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
  ["owner", "received"]
);

await store.markWaiting("ENG-3", "sha-1");
await store.markWaiting("ENG-3", "sha-2");
assert.deepEqual(await store.listWaiting(), [
  { checkedSha: "sha-2", issue: "ENG-3" },
]);
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
  const claim = await store.claim("ENG-3", "fixed", "msg", null);
  assert.ok(claim.ok);
  await store.release("ENG-3", "fixed", claim.token);
}, Promise.resolve());
assert.deepEqual(
  await store.claim("ENG-3", "fixed", "msg", null),
  { ok: false, reason: "exhausted" },
  "five attempts is the limit"
);

await assert.rejects(
  pool.query(
    "INSERT INTO reporter_updates (issue, stage, status) VALUES ('ENG-4', 'nonsense', 'sent')"
  )
);

await pool.end();
console.log("reporter store checks passed");
