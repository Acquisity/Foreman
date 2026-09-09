import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { type SupportClaim, supportClaim } from "./auth.js";
import { conversationId, slackTimestamp } from "./config.js";

const rowSchema = z.object({
  conversation: conversationId,
  delivery_attempted: z.boolean(),
  last_report_hash: z.string().nullable(),
  processed_version: z.string().nullable(),
  report: z.string().nullable(),
  report_key: z.string().nullable(),
  report_kind: z.enum(["final", "retry", "failure"]).nullable(),
  thread: slackTimestamp,
  version: z.string().nullable(),
});
export type SupportRow = z.infer<typeof rowSchema>;

/** Private operational tables; never query customer data or memory cases here. */
function query(text: string, values: unknown[] = []) {
  const url = process.env.FOREMAN_MEMORY_DATABASE_URL;
  if (!url) {
    throw new Error("Support processing store is not configured.");
  }
  return neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(15_000) },
  }).query(text, values);
}

export async function supportCursor(since: string): Promise<string> {
  await query(
    "INSERT INTO support_cursor(id, oldest) VALUES (true, $1) ON CONFLICT DO NOTHING",
    [since]
  );
  const rows = await query("SELECT oldest FROM support_cursor WHERE id = true");
  return slackTimestamp.parse(rows[0]?.oldest);
}

export async function saveSupportCursor(oldest: string) {
  await query(
    "UPDATE support_cursor SET oldest = GREATEST(oldest::numeric, $1::numeric)::text WHERE id = true",
    [oldest]
  );
}

export async function discoverHandoff(conversation: string, thread: string) {
  await query(
    "INSERT INTO support_handoffs(conversation, thread) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [conversationId.parse(conversation), slackTimestamp.parse(thread)]
  );
}

export async function claimHandoffs(
  conversations: string[] = []
): Promise<SupportClaim[]> {
  const rows = await query(
    `WITH due AS (
    SELECT conversation, thread FROM support_handoffs
    WHERE NOT closed AND next_check <= now() AND (lease_until IS NULL OR lease_until < now())
    AND (cardinality($2::text[]) = 0 OR conversation = ANY($2::text[]))
    ORDER BY next_check LIMIT 3 FOR UPDATE SKIP LOCKED
  ) UPDATE support_handoffs h SET lease = $1, lease_until = now() + interval '20 minutes'
    FROM due WHERE h.conversation = due.conversation AND h.thread = due.thread
    RETURNING h.conversation, h.thread, h.lease`,
    [randomUUID(), conversations]
  );
  return z.array(supportClaim).parse(rows);
}

export async function requireSupportLease(
  claim: SupportClaim
): Promise<SupportRow> {
  if (process.env.FOREMAN_SUPPORT_ENABLED !== "true") {
    throw new Error("Support cron is disabled.");
  }
  const rows = await query(
    `SELECT * FROM support_handoffs
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()`,
    [claim.conversation, claim.thread, claim.lease]
  );
  if (!rows[0]) {
    throw new Error("Support processing lease expired.");
  }
  return rowSchema.parse(rows[0]);
}

export async function setSupportVersion(claim: SupportClaim, version: string) {
  await requireSupportLease(claim);
  await query(
    "UPDATE support_handoffs SET version = $4 WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()",
    [claim.conversation, claim.thread, claim.lease, version]
  );
}

export async function releaseSupport(
  claim: SupportClaim,
  closed = false,
  processed = false
) {
  await query(
    `UPDATE support_handoffs SET lease = NULL, lease_until = NULL,
    next_check = now() + interval '10 minutes', closed = $4,
    processed_version = CASE WHEN $5 THEN version ELSE processed_version END
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()`,
    [claim.conversation, claim.thread, claim.lease, closed, processed]
  );
}

export async function queueSupportReport(
  claim: SupportClaim,
  report: string,
  hash: string,
  kind: "final" | "retry" | "failure" = "final"
) {
  await requireSupportLease(claim);
  await query(
    `UPDATE support_handoffs SET report = $4, report_key = $5, report_hash = $6, report_kind = $7,
    delivery_attempted = false WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() AND report IS NULL`,
    [
      claim.conversation,
      claim.thread,
      claim.lease,
      report,
      randomUUID(),
      hash,
      kind,
    ]
  );
}

export async function attemptSupportDelivery(claim: SupportClaim) {
  await requireSupportLease(claim);
  const rows = await query(
    "UPDATE support_handoffs SET delivery_attempted = true WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now() AND NOT delivery_attempted RETURNING report_key",
    [claim.conversation, claim.thread, claim.lease]
  );
  return rows.length === 1;
}

export async function discardSupportReport(claim: SupportClaim) {
  await query(
    "UPDATE support_handoffs SET report = NULL, report_key = NULL, delivery_attempted = false WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()",
    [claim.conversation, claim.thread, claim.lease]
  );
}

export async function completeSupportDelivery(claim: SupportClaim, ts: string) {
  await query(
    `UPDATE support_handoffs SET posted_ts = $4, report = NULL, report_key = NULL,
    last_report_hash = report_hash, processed_version = CASE WHEN report_kind = 'final' THEN version ELSE processed_version END, lease = NULL, lease_until = NULL, next_check = now() + interval '10 minutes'
    WHERE conversation = $1 AND thread = $2 AND lease = $3 AND lease_until > now()`,
    [claim.conversation, claim.thread, claim.lease, slackTimestamp.parse(ts)]
  );
}

/** Reserve before a write. An ambiguous write is never blindly replayed. */
export async function reserveSupportOperation(
  claim: SupportClaim,
  key: string
) {
  await requireSupportLease(claim);
  const added = await query(
    `INSERT INTO support_operations(conversation, thread, operation_key, state)
    SELECT conversation, thread, $3, 'started' FROM support_handoffs
    WHERE conversation = $1 AND thread = $2 AND lease = $4 AND lease_until > now()
    ON CONFLICT (conversation, thread, operation_key)
    DO UPDATE SET state = 'started', result = NULL WHERE support_operations.state = 'failed'
    RETURNING operation_key`,
    [claim.conversation, claim.thread, key, claim.lease]
  );
  if (added.length) {
    return { fresh: true as const };
  }
  const rows = await query(
    "SELECT state, result FROM support_operations WHERE conversation = $1 AND thread = $2 AND operation_key = $3",
    [claim.conversation, claim.thread, key]
  );
  if (rows[0]?.state !== "done") {
    throw new Error(
      "A prior Linear write has an uncertain result. Reconcile that operation before retrying; do not create a replacement."
    );
  }
  return { fresh: false as const, result: rows[0].result as unknown };
}

export async function completeSupportOperation(
  claim: SupportClaim,
  key: string,
  result: unknown,
  state: "done" | "failed" = "done"
) {
  await query(
    "UPDATE support_operations SET state = $5, result = $4::jsonb WHERE conversation = $1 AND thread = $2 AND operation_key = $3",
    [claim.conversation, claim.thread, key, JSON.stringify(result), state]
  );
}

export async function supportOperations(claim: SupportClaim) {
  await requireSupportLease(claim);
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
  await requireSupportLease(claim);
  await query(
    `INSERT INTO support_operations(conversation, thread, operation_key, state, result)
    SELECT conversation, thread, $3, 'done', $4::jsonb FROM support_handoffs
    WHERE conversation = $1 AND thread = $2 AND lease = $5 AND lease_until > now()
    ON CONFLICT (conversation, thread, operation_key) DO UPDATE SET state = 'done', result = EXCLUDED.result
    WHERE support_operations.state <> 'done'`,
    [claim.conversation, claim.thread, key, JSON.stringify(result), claim.lease]
  );
  return reserveSupportOperation(claim, key);
}
