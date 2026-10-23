import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { createReporterStore } from "../agent/lib/reporter-updates/store.js";

const url = process.env.REPORTER_STORE_TEST_URL;
if (!url) {
  throw new Error("REPORTER_STORE_TEST_URL is not set.");
}

const pool = new pg.Pool({ connectionString: url, max: 8 });
const store = createReporterStore(
  async (text, values) => (await pool.query(text, values)).rows
);

const migration = await readFile(
  join(import.meta.dirname, "..", "migrations", "0013_reporter_updates.sql"),
  "utf8"
);
await pool.query("DROP TABLE IF EXISTS reporter_updates");
const COMMENT_ONLY = /^(?:--[^\n]*\n?)+$/;
const statements = migration
  .split(/;\s*$/m)
  .map((statement) => statement.trim())
  .filter((statement) => statement && !COMMENT_ONLY.test(statement));
await statements.reduce(
  (previous, statement) => previous.then(() => pool.query(statement)),
  Promise.resolve<unknown>(undefined)
);

const claims = await Promise.all(
  Array.from({ length: 8 }, () =>
    store.claim("ENG-1", "fixed", "Good news", "C0AAAAAAAAA")
  )
);
assert.equal(
  claims.filter(Boolean).length,
  1,
  "eight racing claims, one winner"
);

assert.equal(await store.claim("ENG-1", "fixed", "again", null), false);

await pool.query(
  "UPDATE reporter_updates SET claimed_at = now() - interval '11 minutes' WHERE issue = 'ENG-1'"
);
assert.equal(
  await store.claim("ENG-1", "fixed", "retry", null),
  true,
  "stale claim is taken over"
);

await store.markSent(
  "ENG-1",
  ["fixed"],
  "Good news",
  "C0AAAAAAAAA",
  "comment-1"
);
assert.equal(
  await store.claim("ENG-1", "fixed", "again", null),
  false,
  "sent is final"
);
await store.markWaiting("ENG-1", "abc1234");
const rows = await store.rows("ENG-1");
assert.deepEqual(
  rows.map((row) => [row.stage, row.status, row.commentId]),
  [["fixed", "sent", "comment-1"]],
  "markWaiting never reopens a sent row"
);

await store.markSent(
  "ENG-2",
  ["received", "owner"],
  "Hello",
  null,
  "comment-2"
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
assert.equal(
  await store.claim("ENG-3", "fixed", "msg", null),
  true,
  "waiting row can be claimed"
);
await store.release("ENG-3", "fixed");
assert.equal(
  (await store.rows("ENG-3"))[0]?.status,
  "waiting",
  "release returns it to waiting"
);
assert.equal(await store.claim("ENG-3", "fixed", "msg", null), true);

await assert.rejects(
  pool.query(
    "INSERT INTO reporter_updates (issue, stage, status) VALUES ('ENG-4', 'nonsense', 'sent')"
  )
);

await pool.end();
console.log("reporter store checks passed");
