import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FinInvestigationOutcome } from "./fin-investigation-callback.js";
import type { FinInvestigationSlackReceipt } from "./fin-investigation-slack.js";
import { type FinContext, finContextSchema } from "./fin-scope.js";
import { privateDatabase } from "./private-postgres.js";

export const FIN_RESULT_WINDOW_MS = 60 * 60 * 1000;
const runSchema = z.object({
  callback_attempts: z.number().int(),
  callback_delivered: z.boolean(),
  callback_url: z.string(),
  completed_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  id: z.uuid(),
  outcome: z
    .object({ message: z.string(), status: z.enum(["completed", "failed"]) })
    .nullable(),
  scope: finContextSchema,
  session_id: z.string().nullable(),
  slack: z
    .object({ channel: z.string(), delivered: z.boolean(), ts: z.string() })
    .nullable(),
});
export type FinRun = z.infer<typeof runSchema>;

export function sameFinOwner(a: FinContext, b: FinContext) {
  return (
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.intercomAppId === b.intercomAppId &&
    a.conversationId === b.conversationId &&
    a.contactId === b.contactId &&
    a.origin === b.origin &&
    a.partnerId === b.partnerId &&
    a.organizationSlug === b.organizationSlug
  );
}

export function assertFinRunOwner(
  run: FinRun,
  scope: FinContext,
  now = Date.now()
) {
  if (
    !sameFinOwner(run.scope, scope) ||
    now >= run.created_at.getTime() + FIN_RESULT_WINDOW_MS
  ) {
    throw new Error("Investigation unavailable for this conversation.");
  }
}

/** SQL uniqueness, not a process-local lock, arbitrates overlapping HTTP requests. */
export async function claimFinRun(
  scope: FinContext,
  requestKey: string,
  callbackUrl: string,
  retry = true
): Promise<{ fresh: boolean; run: FinRun }> {
  const db = privateDatabase();
  const inserted = await db.query(
    `INSERT INTO fin_investigation_runs (id, app_id, conversation_id, request_key, scope, callback_url)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) ON CONFLICT DO NOTHING RETURNING *`,
    [
      randomUUID(),
      scope.intercomAppId,
      scope.conversationId,
      requestKey,
      JSON.stringify(scope),
      callbackUrl,
    ]
  );
  if (inserted.length) {
    return { fresh: true, run: runSchema.parse(inserted[0]) };
  }
  const rows = await db.query(
    `SELECT * FROM fin_investigation_runs WHERE app_id = $1 AND conversation_id = $2
     AND (request_key = $3 OR completed_at IS NULL) ORDER BY (request_key = $3) DESC LIMIT 1`,
    [scope.intercomAppId, scope.conversationId, requestKey]
  );
  if (!rows.length) {
    // The conflicting active run can finish between INSERT and SELECT.
    if (retry) {
      return claimFinRun(scope, requestKey, callbackUrl, false);
    }
    throw new Error("Investigation run could not be claimed.");
  }
  const run = runSchema.parse(rows[0]);
  assertFinRunOwner(run, scope);
  return { fresh: false, run };
}

export async function readFinRun(id: string): Promise<FinRun> {
  const rows = await privateDatabase().query(
    "SELECT * FROM fin_investigation_runs WHERE id = $1",
    [z.uuid().parse(id)]
  );
  return runSchema.parse(rows[0]);
}

export async function attachFinRun(
  id: string,
  sessionId: string,
  slack: FinInvestigationSlackReceipt | null
) {
  const rows = await privateDatabase().query(
    `UPDATE fin_investigation_runs SET session_id = $2, slack = $3::jsonb
     WHERE id = $1 AND (session_id IS NULL OR session_id = $2) RETURNING id`,
    [id, sessionId, JSON.stringify(slack)]
  );
  if (rows.length !== 1) {
    throw new Error("Investigation session ownership mismatch.");
  }
}

/** Terminal result is immutable. Replayed terminal events cannot overwrite another outcome. */
export async function completeFinRun(
  id: string,
  outcome: FinInvestigationOutcome
) {
  await privateDatabase().query(
    `UPDATE fin_investigation_runs SET outcome = $2::jsonb, completed_at = now()
     WHERE id = $1 AND completed_at IS NULL`,
    [id, JSON.stringify(outcome)]
  );
  return readFinRun(id);
}

/** One signal attempt. Authenticated result reads recover a missed signal without retrying work. */
export async function reserveFinCallback(id: string) {
  const rows = await privateDatabase().query(
    `UPDATE fin_investigation_runs SET callback_attempts = callback_attempts + 1
     WHERE id = $1 AND completed_at IS NOT NULL AND callback_delivered = false
       AND callback_attempts = 0 AND created_at > now() - interval '1 hour' RETURNING id`,
    [id]
  );
  return rows.length === 1;
}

export async function markFinCallback(id: string) {
  await privateDatabase().query(
    "UPDATE fin_investigation_runs SET callback_delivered = true WHERE id = $1",
    [id]
  );
}
