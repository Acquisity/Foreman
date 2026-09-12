import { randomUUID } from "node:crypto";
import { z } from "zod";
import { privateDatabase } from "../private-postgres.js";
import { type SupportClaim, supportClaim } from "./auth.js";
import {
  conversationId,
  type SupportScheduleMode,
  slackTimestamp,
  supportEnabled,
} from "./config.js";
import {
  SupportLeaseLost,
  SupportRefusal,
  SupportStateConflict,
} from "./errors.js";
import { type LinearSnapshot, linearSnapshot } from "./linear-state.js";

const rowSchema = z.object({
  conversation: conversationId,
  delivery_attempted: z.boolean(),
  last_report_hash: z.string().nullable(),
  linear_ids: z.array(z.string()).max(10),
  linear_observed: linearSnapshot,
  linear_processed: linearSnapshot,
  processed_version: z.string().nullable(),
  report: z.string().nullable(),
  report_key: z.string().nullable(),
  report_kind: z.enum(["final", "retry", "failure"]).nullable(),
  report_revision: z.string().nullable(),
  thread: slackTimestamp,
  version: z.string().nullable(),
});
export type SupportRow = z.infer<typeof rowSchema>;

/** Private operational tables; never query customer data or memory cases here. */
function query(text: string, values: unknown[] = []) {
  return privateDatabase().query(text, values);
}

const cursorSchema = z.object({
  oldest: slackTimestamp,
  scan_latest: slackTimestamp.nullable(),
  scan_newest: slackTimestamp.nullable(),
});
export type SupportCursor = z.infer<typeof cursorSchema>;

export async function supportCursor(since: string): Promise<SupportCursor> {
  await query(
    "INSERT INTO support_cursor(id, oldest) VALUES (true, $1) ON CONFLICT DO NOTHING",
    [since]
  );
  const rows = await query(
    "SELECT oldest, scan_latest, scan_newest FROM support_cursor WHERE id = true"
  );
  return cursorSchema.parse(rows[0]);
}

export async function saveSupportCursor(
  previous: SupportCursor,
  next: SupportCursor
) {
  const before = cursorSchema.parse(previous);
  const after = cursorSchema.parse(next);
  const rows = await query(
    `UPDATE support_cursor SET oldest=$4, scan_latest=$5, scan_newest=$6
     WHERE id=true AND oldest=$1 AND scan_latest IS NOT DISTINCT FROM $2::text
       AND scan_newest IS NOT DISTINCT FROM $3::text
       AND $4::numeric >= oldest::numeric RETURNING id`,
    [
      before.oldest,
      before.scan_latest,
      before.scan_newest,
      after.oldest,
      after.scan_latest,
      after.scan_newest,
    ]
  );
  return rows.length === 1;
}

export async function discoverHandoff(conversation: string, thread: string) {
  await query(
    "INSERT INTO support_handoffs(conversation, thread) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [conversationId.parse(conversation), slackTimestamp.parse(thread)]
  );
}

export async function claimHandoffs(
  mode: SupportScheduleMode,
  conversations: string[] = []
): Promise<(SupportClaim & { reclaimed: boolean })[]> {
  const rows = await query(
    `WITH due AS (
    SELECT conversation, thread, lease_until IS NOT NULL AS reclaimed FROM support_handoffs
    WHERE NOT closed AND next_check <= now() AND (lease_until IS NULL OR lease_until < now())
    AND (($3 = 'intake' AND processed_version IS NULL) OR ($3 = 'followups' AND processed_version IS NOT NULL))
    AND (cardinality($2::text[]) = 0 OR conversation = ANY($2::text[]))
    ORDER BY next_check LIMIT 3 FOR UPDATE SKIP LOCKED
  ) UPDATE support_handoffs h SET lease = $1, lease_until = now() + interval '20 minutes'
    FROM due WHERE h.conversation = due.conversation AND h.thread = due.thread
    RETURNING h.conversation, h.thread, h.lease, due.reclaimed`,
    [randomUUID(), conversations, mode]
  );
  return z.array(supportClaim.extend({ reclaimed: z.boolean() })).parse(rows);
}

export async function findSupportLease(
  claim: SupportClaim
): Promise<SupportRow | null> {
  if (!supportEnabled()) {
    return null;
  }
  const rows = await query(
    "SELECT * FROM support_handoffs WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()",
    [claim.conversation, claim.thread, claim.lease]
  );
  return rows[0] ? rowSchema.parse(rows[0]) : null;
}

export async function requireSupportLease(
  claim: SupportClaim
): Promise<SupportRow> {
  const row = await findSupportLease(claim);
  if (!row) {
    throw new SupportLeaseLost(
      "Support processing lease expired or the cron is disabled."
    );
  }
  return row;
}

/** Each ordinary state write fences its lease atomically; zero rows are never silent success. */
async function guardedWrite(sql: string, values: unknown[]) {
  if (!supportEnabled()) {
    throw new SupportLeaseLost("Support cron is disabled.");
  }
  const rows = await query(sql, values);
  if (!rows.length) {
    throw new SupportStateConflict(
      "Support state changed or its lease expired. Reopen the case before retrying."
    );
  }
  return rows;
}

export async function setSupportVersion(
  claim: SupportClaim,
  version: string,
  snapshot: LinearSnapshot = {}
) {
  await guardedWrite(
    "UPDATE support_handoffs SET version = $4, linear_observed = $5::jsonb WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() RETURNING 1",
    [
      claim.conversation,
      claim.thread,
      claim.lease,
      version,
      JSON.stringify(snapshot),
    ]
  );
}

export async function settleSupport(
  claim: SupportClaim,
  {
    closed = false,
    processed = false,
  }: { closed?: boolean; processed?: boolean } = {}
) {
  await guardedWrite(
    `UPDATE support_handoffs SET lease = NULL, lease_until = NULL,
    next_check = now() + interval '10 minutes', closed = $4,
    processed_version = CASE WHEN $5 THEN version ELSE processed_version END,
    linear_processed = CASE WHEN $5 THEN linear_observed ELSE linear_processed END
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()
      AND (NOT $4 OR report IS NULL OR NOT delivery_attempted) RETURNING 1`,
    [claim.conversation, claim.thread, claim.lease, closed, processed]
  );
}

export async function queueSupportReport(
  claim: SupportClaim,
  report: string,
  hash: string,
  kind: "final" | "retry" | "failure" = "final",
  revision: string | null = null
) {
  await guardedWrite(
    `UPDATE support_handoffs SET report = $4, report_key = $5, report_hash = $6, report_kind = $7,
    delivery_attempted = false, report_revision = $8 WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() AND report IS NULL RETURNING 1`,
    [
      claim.conversation,
      claim.thread,
      claim.lease,
      report,
      randomUUID(),
      hash,
      kind,
      revision,
    ]
  );
}

export async function attemptSupportDelivery(claim: SupportClaim) {
  const rows = await guardedWrite(
    "UPDATE support_handoffs SET delivery_attempted = true WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() AND NOT delivery_attempted AND report IS NOT NULL RETURNING report_key",
    [claim.conversation, claim.thread, claim.lease]
  );
  return rows[0].report_key;
}

export async function discardSupportReport(claim: SupportClaim) {
  await guardedWrite(
    "UPDATE support_handoffs SET report = NULL, report_key = NULL, delivery_attempted = false WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() AND (report IS NULL OR NOT delivery_attempted) RETURNING 1",
    [claim.conversation, claim.thread, claim.lease]
  );
}

export async function completeSupportDelivery(
  claim: SupportClaim,
  ts: string,
  closed = false
) {
  await guardedWrite(
    `UPDATE support_handoffs SET posted_ts = $4, report = NULL, report_key = NULL, delivery_attempted = false,
    last_report_hash = report_hash, processed_version = CASE WHEN report_kind = 'final' THEN version ELSE processed_version END,
    linear_processed = CASE WHEN report_kind = 'final' THEN linear_observed ELSE linear_processed END,
    closed = closed OR $5, lease = NULL, lease_until = NULL, next_check = now() + interval '10 minutes'
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() RETURNING 1`,
    [
      claim.conversation,
      claim.thread,
      claim.lease,
      slackTimestamp.parse(ts),
      closed,
    ]
  );
}

/** Persist verified issue references immediately, independent of Slack success. */
export async function trackSupportIssue(claim: SupportClaim, issueId: string) {
  const id = z.string().min(1).max(100).parse(issueId);
  const [row] = await guardedWrite(
    `UPDATE support_handoffs
    SET linear_ids = CASE WHEN $4 = ANY(linear_ids) OR cardinality(linear_ids) >= 10
      THEN linear_ids ELSE array_append(linear_ids, $4) END
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()
    RETURNING ($4 = ANY(linear_ids)) AS tracked`,
    [claim.conversation, claim.thread, claim.lease, id]
  );
  if (!row.tracked) {
    throw new SupportRefusal(
      "This case already tracks 10 Linear issues. The additional issue was not added to follow-up monitoring. Do not retry it or create a replacement; operator reconciliation is required."
    );
  }
}

/** Reserve before a write. An ambiguous write is never blindly replayed. */
export async function reserveSupportOperation(
  claim: SupportClaim,
  key: string
) {
  if (!supportEnabled()) {
    throw new SupportLeaseLost("Support cron is disabled.");
  }
  const added = await query(
    `INSERT INTO support_operations(conversation, thread, operation_key, state, reservation_lease)
    SELECT conversation, thread, $3, 'started', $4 FROM support_handoffs
    WHERE conversation = $1 AND thread = $2 AND lease = $4 AND lease_until > now()
    ON CONFLICT (conversation, thread, operation_key)
    DO UPDATE SET state = 'started', result = NULL, reservation_lease = EXCLUDED.reservation_lease WHERE support_operations.state = 'failed'
    RETURNING operation_key`,
    [claim.conversation, claim.thread, key, claim.lease]
  );
  if (added.length) {
    return { fresh: true as const };
  }
  // An existing completed result is an explicit replay, not a successful new write.
  const rows = await query(
    `SELECT o.state, o.result FROM support_operations o JOIN support_handoffs h USING (conversation, thread)
    WHERE o.conversation = $1 AND o.thread = $2 AND operation_key = $3 AND h.lease = $4 AND h.lease_until > now()`,
    [claim.conversation, claim.thread, key, claim.lease]
  );
  if (!rows.length) {
    throw new SupportLeaseLost("Support processing lease expired.");
  }
  if (rows[0].state !== "done") {
    throw new SupportRefusal(
      "A prior Linear write is uncertain. Reconcile it before retrying; do not create a replacement."
    );
  }
  return { fresh: false as const, result: rows[0].result as unknown };
}

/** Late provider receipts are fenced by the operation reservation, not the now-expired case lease. */
export async function completeSupportOperation(
  claim: SupportClaim,
  key: string,
  result: unknown,
  state: "done" | "failed" = "done"
) {
  const rows = await query(
    `UPDATE support_operations SET state = $5, result = $4::jsonb
    WHERE conversation = $1 AND thread = $2 AND operation_key = $3 AND reservation_lease = $6 AND state = 'started' RETURNING 1`,
    [
      claim.conversation,
      claim.thread,
      key,
      JSON.stringify(result),
      state,
      claim.lease,
    ]
  );
  if (!rows.length) {
    throw new SupportStateConflict(
      "The Linear receipt does not own this operation reservation."
    );
  }
}

/** The caller supplies its already fenced case row. */
export function supportOperations(
  claim: Pick<SupportRow, "conversation" | "thread">
) {
  return query(
    "SELECT operation_key, state, result FROM support_operations WHERE conversation = $1 AND thread = $2 ORDER BY operation_key LIMIT 100",
    [claim.conversation, claim.thread]
  );
}

export async function recordMatchedSupportIssue(
  claim: SupportClaim,
  key: string,
  result: unknown
) {
  const rows = await guardedWrite(
    `INSERT INTO support_operations(conversation, thread, operation_key, state, result)
    SELECT conversation, thread, $3, 'done', $4::jsonb FROM support_handoffs
    WHERE conversation = $1 AND thread = $2 AND lease = $5 AND lease_until > now()
    ON CONFLICT (conversation, thread, operation_key) DO UPDATE SET state = 'done',
      result = CASE WHEN support_operations.state = 'done' THEN support_operations.result ELSE EXCLUDED.result END
    RETURNING result`,
    [claim.conversation, claim.thread, key, JSON.stringify(result), claim.lease]
  );
  return { fresh: false as const, result: rows[0].result as unknown };
}
