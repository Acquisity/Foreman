/**
 * Pull new production widget conversations into eval case candidates (ENG-14750).
 *
 * Usage: pnpm widget:candidates [--since <ISO date>] [--exclude-orgs <uuid,uuid>]
 *
 * FOREMAN_MEMORY_DATABASE_URL must point at production. Test workspaces are
 * excluded by --exclude-orgs or WIDGET_CANDIDATES_EXCLUDE_ORGS. Without --since
 * the pull starts after the newest run already pulled, recorded in
 * `.eve/widget-candidates/state.json`. Flagged conversations are written to a
 * review file under `.eve/widget-candidates/`, and each flagged investigation
 * run goes through `scripts/widget-case-from-run.ts` into
 * `evals/widget/cases-pending/` with empty expectations. It only reads: one
 * SELECT on the run store and the converter's own workflow reads.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { privateDatabase } from "../agent/lib/private-postgres.js";
import {
  CANDIDATES_OUTPUT,
  type CandidateRow,
  candidateRowSchema,
  flagConversations,
  nextPullState,
  type PullState,
  parseExcludedOrgs,
  pendingCaseName,
  pullStateSchema,
  renderReview,
} from "../agent/lib/widget-candidates.js";

const run = promisify(execFile);
const STATE = `${CANDIDATES_OUTPUT}/state.json`;
const PENDING = "evals/widget/cases-pending";
const QUERY_DEADLINE_MS = 30_000;
// The converter makes up to four 180s CLI calls of its own.
const CONVERTER_DEADLINE_MS = 900_000;
const ROW_LIMIT = 5000;

const { values } = parseArgs({
  options: { "exclude-orgs": { type: "string" }, since: { type: "string" } },
});
const excluded = parseExcludedOrgs(
  values["exclude-orgs"] ?? process.env.WIDGET_CANDIDATES_EXCLUDE_ORGS
);
const previous: PullState | null = existsSync(STATE)
  ? pullStateSchema.parse(JSON.parse(await readFile(STATE, "utf8")))
  : null;
const since = values.since
  ? z.coerce.date().parse(values.since).toISOString()
  : previous?.through;
if (!since) {
  console.error(
    "Usage: pnpm widget:candidates --since <ISO date> (required until the first pull is recorded)"
  );
  process.exit(2);
}
// An explicit --since is a deliberate re-pull, so nothing counts as seen.
const seen = new Set(values.since ? [] : (previous?.seen ?? []));

// Every completed customer run of each conversation that has a run completed
// since the cursor. Inbox runs are a teammate's instruction, never a customer turn.
const rows = z.array(candidateRowSchema).parse(
  await privateDatabase(QUERY_DEADLINE_MS).query(
    `SELECT id, organization_id, conversation_id, question, scope, session_id, findings,
         decision, outcome, created_at, completed_at
       FROM widget_support_runs
       WHERE completed_at IS NOT NULL AND scope->>'source' IS DISTINCT FROM 'inbox'
         AND (organization_id, conversation_id) IN (
           SELECT organization_id, conversation_id FROM widget_support_runs
           WHERE completed_at >= $1 AND scope->>'source' IS DISTINCT FROM 'inbox')
       ORDER BY created_at LIMIT ${ROW_LIMIT + 1}`,
    [since]
  )
);
if (rows.length > ROW_LIMIT) {
  throw new Error(
    `More than ${ROW_LIMIT} runs since ${since}. Pass a later --since. Nothing was written.`
  );
}
const isNew = (row: CandidateRow) =>
  row.completed_at.toISOString() >= since && !seen.has(row.id);
const candidates = flagConversations(rows, { excluded, isNew });

const pulledAt = new Date().toISOString();
await mkdir(CANDIDATES_OUTPUT, { recursive: true });
if (candidates.length) {
  const review = `${CANDIDATES_OUTPUT}/review-${pulledAt.replaceAll(":", "-")}.md`;
  await writeFile(review, renderReview(candidates, pulledAt));
  console.log(
    `Wrote ${review}: ${candidates.length} flagged conversations of ${new Set(rows.filter(isNew).map((row) => row.conversation_id)).size} with new runs.`
  );
} else {
  console.log(`No new flagged conversations since ${since}.`);
}

// The converter writes into the active set; each new case moves straight to
// pending, where the replay eval does not discover it.
const refused: string[] = [];
await mkdir(PENDING, { recursive: true });
for (const sessionId of new Set(
  candidates.flatMap((c) => c.investigationSessions)
)) {
  const name = pendingCaseName(sessionId);
  if (existsSync(`${PENDING}/${name}.json`)) {
    continue;
  }
  try {
    // biome-ignore lint/performance/noAwaitInLoops: one production decrypt at a time keeps the audit trail and CLI load small.
    await run(
      "npx",
      ["tsx", "scripts/widget-case-from-run.ts", sessionId, "production", name],
      { maxBuffer: 16 * 1024 * 1024, timeout: CONVERTER_DEADLINE_MS }
    );
    await rename(`evals/widget/cases/${name}.json`, `${PENDING}/${name}.json`);
    console.log(`Wrote ${PENDING}/${name}.json`);
  } catch (error) {
    // A refused save (leak check, empty stream, deadline) is reported, never fatal.
    const lines = (error as { stderr?: string }).stderr?.split("\n") ?? [];
    const message =
      lines.find((line) => line.includes("Error")) ?? String(error);
    refused.push(`${sessionId}: ${message}`);
  }
}
if (refused.length) {
  console.log(`Not converted:\n${refused.join("\n")}`);
}

const state = nextPullState(rows, previous);
if (state) {
  await writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`);
}
