import { randomUUID } from "node:crypto";
import { z } from "zod";
import { privateDatabase } from "./private-postgres.js";
import {
  sameWidgetOwner,
  type WidgetContext,
  widgetContextSchema,
} from "./widget-scope.js";

/** Match Fin: a pending result stays readable for two hours, then the reference is dead. */
export const WIDGET_RESULT_WINDOW_MS = 2 * 60 * 60 * 1000;

export const widgetOutcomeSchema = z.object({
  // Help-center sources behind a knowledge-base lane answer, numbered to match
  // the [n] markers in `message`. Absent on investigation outcomes.
  citations: z
    .array(
      z.object({
        n: z.number().int().positive(),
        title: z.string(),
        url: z.string(),
      })
    )
    .optional(),
  decision: z.enum(["allow", "rewrite", "block"]),
  message: z.string().nullable(),
  reason: z.string(),
  status: z.enum(["completed", "failed"]),
});
export type WidgetOutcome = z.infer<typeof widgetOutcomeSchema>;

const runSchema = z.object({
  completed_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  decision: z.string().nullable(),
  findings: z.unknown().nullable(),
  id: z.uuid(),
  outcome: widgetOutcomeSchema.nullable(),
  question: z.string(),
  scope: widgetContextSchema,
  session_id: z.string().nullable(),
  stream_index: z.number().int().nonnegative(),
});
export type WidgetRun = z.infer<typeof runSchema>;

export function assertWidgetRunOwner(
  run: WidgetRun,
  scope: WidgetContext,
  now = Date.now()
) {
  if (
    !sameWidgetOwner(run.scope, scope) ||
    now >= run.created_at.getTime() + WIDGET_RESULT_WINDOW_MS
  ) {
    throw new Error("Investigation unavailable for this conversation.");
  }
}

/** The scope the conversation's most recent run was verified under, for drift checks. */
export async function latestWidgetScope(
  scope: WidgetContext
): Promise<WidgetContext | null> {
  const rows = await privateDatabase().query(
    `SELECT scope FROM widget_support_runs WHERE organization_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [scope.organizationId, scope.conversationId]
  );
  return rows.length ? widgetContextSchema.parse(rows[0].scope) : null;
}

const RECENT_TURNS = 4;

/**
 * The earlier turns of this run's conversation, oldest first, rebuilt from the
 * runs themselves: each holds the customer's message and the reply that went
 * out. The reply is often written in a later request than the one that started
 * the run, so the conversation is read here rather than carried from the client.
 * Turns that were blocked have no reply and contribute only the question.
 */
export async function recentWidgetTurns(
  run: Pick<WidgetRun, "created_at" | "id" | "scope">
): Promise<{ role: "customer" | "assistant"; text: string }[]> {
  const rows = await privateDatabase().query(
    `SELECT question, outcome FROM widget_support_runs
     WHERE organization_id = $1 AND conversation_id = $2 AND id <> $3 AND created_at < $4
     ORDER BY created_at DESC LIMIT ${RECENT_TURNS}`,
    [run.scope.organizationId, run.scope.conversationId, run.id, run.created_at]
  );
  return rows.reverse().flatMap((row) => {
    const reply = widgetOutcomeSchema.nullable().safeParse(row.outcome);
    const message = reply.success ? reply.data?.message : null;
    return [
      { role: "customer" as const, text: String(row.question) },
      ...(message ? [{ role: "assistant" as const, text: message }] : []),
    ];
  });
}

/** SQL uniqueness, not a process-local lock, arbitrates overlapping HTTP requests. */
export async function claimWidgetRun(
  scope: WidgetContext,
  requestKey: string,
  question: string,
  retry = true
): Promise<{ fresh: boolean; run: WidgetRun }> {
  const db = privateDatabase();
  const inserted = await db.query(
    `INSERT INTO widget_support_runs (id, organization_id, conversation_id, request_key, question, scope)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING RETURNING *`,
    [
      randomUUID(),
      scope.organizationId,
      scope.conversationId,
      requestKey,
      question,
      JSON.stringify(scope),
    ]
  );
  if (inserted.length) {
    return { fresh: true, run: runSchema.parse(inserted[0]) };
  }
  const rows = await db.query(
    `SELECT * FROM widget_support_runs WHERE organization_id = $1 AND conversation_id = $2
     AND (request_key = $3 OR completed_at IS NULL) ORDER BY (request_key = $3) DESC LIMIT 1`,
    [scope.organizationId, scope.conversationId, requestKey]
  );
  if (!rows.length) {
    if (retry) {
      return claimWidgetRun(scope, requestKey, question, false);
    }
    throw new Error("Investigation run could not be claimed.");
  }
  const run = runSchema.parse(rows[0]);
  assertWidgetRunOwner(run, scope);
  return { fresh: false, run };
}

export async function readWidgetRun(id: string): Promise<WidgetRun> {
  const rows = await privateDatabase().query(
    "SELECT * FROM widget_support_runs WHERE id = $1",
    [z.uuid().parse(id)]
  );
  return runSchema.parse(rows[0]);
}

/** The stream index marks where this turn starts, so recovery on a multi-turn session never replays an older completion. */
export async function attachWidgetRun(
  id: string,
  sessionId: string,
  streamIndex: number
) {
  const rows = await privateDatabase().query(
    `UPDATE widget_support_runs SET session_id = $2, stream_index = $3
     WHERE id = $1 AND (session_id IS NULL OR session_id = $2) RETURNING id`,
    [id, sessionId, streamIndex]
  );
  if (rows.length !== 1) {
    throw new Error("Investigation session ownership mismatch.");
  }
}

/** Terminal result is immutable. Replayed terminal events cannot overwrite another outcome. */
export async function completeWidgetRun(
  id: string,
  outcome: WidgetOutcome,
  findings: unknown,
  sessionId: string
) {
  await privateDatabase().query(
    `UPDATE widget_support_runs SET outcome = $2::jsonb, findings = $3::jsonb, decision = $4,
       completed_at = now(), session_id = COALESCE(session_id, $5)
     WHERE id = $1 AND completed_at IS NULL AND (session_id IS NULL OR session_id = $5)`,
    [
      id,
      JSON.stringify(outcome),
      JSON.stringify(findings),
      outcome.decision,
      sessionId,
    ]
  );
  const run = await readWidgetRun(id);
  if (run.session_id !== sessionId) {
    throw new Error("Investigation session ownership mismatch.");
  }
  return run;
}
