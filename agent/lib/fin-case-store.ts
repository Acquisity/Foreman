import { z } from "zod";
import {
  type FinCaseDecision,
  finCaseDecision,
  finCaseOutcome,
  sameFinCaseOwner,
} from "./fin-case.js";
import { sameFinOwner } from "./fin-run-store.js";
import { type FinContext, finContextSchema } from "./fin-scope.js";
import { privateDatabase } from "./private-postgres.js";

const issueIdentifier = /^ENG-\d+$/;
const caseSchema = z.object({
  created_at: z.coerce.date(),
  created_here: z.boolean(),
  creation_attempted: z.boolean(),
  decision: finCaseDecision,
  document_attempted: z.boolean(),
  id: z.uuid(),
  issue_id: z.string().regex(issueIdentifier).nullable(),
  outcome: finCaseOutcome.nullable(),
  scope: finContextSchema,
});
export type FinCase = z.infer<typeof caseSchema>;

export async function claimFinCase(
  scope: FinContext,
  sessionId: string,
  decision: FinCaseDecision
) {
  const db = privateDatabase();
  const runs = await db.query(
    "SELECT id, scope FROM fin_investigation_runs WHERE session_id = $1",
    [sessionId]
  );
  const run = z
    .object({ id: z.uuid(), scope: finContextSchema })
    .parse(runs.length === 1 ? runs[0] : null);
  if (!sameFinOwner(run.scope, scope)) {
    throw new Error("Case session ownership mismatch.");
  }
  const unresolved = await db.query(
    `SELECT id FROM fin_cases WHERE id <> $1 AND scope->>'intercomAppId' = $2
     AND scope->>'conversationId' = $3 AND creation_attempted = true AND issue_id IS NULL AND outcome IS NULL LIMIT 1`,
    [run.id, scope.intercomAppId, scope.conversationId]
  );
  if (unresolved.length) {
    throw new Error("An earlier source case requires reconciliation.");
  }
  const inserted = await db.query(
    "INSERT INTO fin_cases (id, scope, decision) VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT DO NOTHING RETURNING *",
    [run.id, JSON.stringify(scope), JSON.stringify(decision)]
  );
  const rows = inserted.length
    ? inserted
    : await db.query("SELECT * FROM fin_cases WHERE id = $1", [run.id]);
  const record = caseSchema.parse(rows[0]);
  if (!sameFinOwner(record.scope, scope)) {
    throw new Error("Case ownership mismatch.");
  }
  return { fresh: inserted.length === 1, record };
}

export async function reserveFinCaseCreation(id: string) {
  const rows = await privateDatabase().query(
    "UPDATE fin_cases SET creation_attempted = true WHERE id = $1 AND creation_attempted = false AND issue_id IS NULL RETURNING id",
    [id]
  );
  return rows.length === 1;
}

export async function bindFinCase(
  id: string,
  issueId: string,
  createdHere: boolean
) {
  const rows = await privateDatabase().query(
    "UPDATE fin_cases SET issue_id = $2, created_here = $3 WHERE id = $1 AND (issue_id IS NULL OR issue_id = $2) RETURNING *",
    [id, z.string().regex(issueIdentifier).parse(issueId), createdHere]
  );
  return caseSchema.parse(rows[0]);
}

export async function reserveFinCaseDocument(id: string) {
  const rows = await privateDatabase().query(
    "UPDATE fin_cases SET document_attempted = true WHERE id = $1 AND document_attempted = false RETURNING id",
    [id]
  );
  return rows.length === 1;
}

export async function finishFinCase(
  id: string,
  outcome: z.infer<typeof finCaseOutcome>
) {
  const rows = await privateDatabase().query(
    "UPDATE fin_cases SET outcome = COALESCE(outcome, $2::jsonb) WHERE id = $1 RETURNING outcome",
    [id, JSON.stringify(outcome)]
  );
  return finCaseOutcome.parse(rows[0]?.outcome);
}

/** Original and fresh chats see only their opener's cases in the freshly verified workspace. */
export async function findFinCases(scope: FinContext, caseId?: string) {
  const db = privateDatabase();
  const query = `SELECT * FROM fin_cases WHERE scope->>'userId' = $1 AND scope->>'organizationId' = $2
     AND issue_id IS NOT NULL AND ($3::uuid IS NULL OR id = $3::uuid)`;
  const values = [scope.userId, scope.organizationId, caseId ?? null];
  const local = caseId
    ? []
    : await db.query(
        `${query} AND scope->>'conversationId' = $4 ORDER BY created_at DESC LIMIT 21`,
        [...values, scope.conversationId]
      );
  const rows = local.length
    ? local
    : await db.query(`${query} ORDER BY created_at DESC LIMIT 21`, values);
  return rows
    .map((row) => caseSchema.parse(row))
    .filter((row) => sameFinCaseOwner(row.scope, scope));
}

/** A saved source association takes precedence over provider search indexing. */
export async function findFinSourceIssue(scope: FinContext) {
  const rows = await privateDatabase().query(
    `SELECT issue_id, bool_and(scope->>'userId' = $3 AND scope->>'organizationId' = $4
       AND scope->>'contactId' = $5 AND scope->>'origin' = $6
       AND scope->>'partnerId' = $7 AND scope->>'organizationSlug' = $8) AS owner_matches
     FROM fin_cases WHERE scope->>'intercomAppId' = $1
     AND scope->>'conversationId' = $2 AND issue_id IS NOT NULL GROUP BY issue_id LIMIT 2`,
    [
      scope.intercomAppId,
      scope.conversationId,
      scope.userId,
      scope.organizationId,
      scope.contactId,
      scope.origin,
      scope.partnerId,
      scope.organizationSlug,
    ]
  );
  const identifiers = new Set<string>();
  for (const row of rows) {
    if (row.owner_matches !== true) {
      throw new Error("Saved source ownership mismatch.");
    }
    identifiers.add(z.string().regex(issueIdentifier).parse(row.issue_id));
  }
  if (identifiers.size > 1) {
    throw new Error("Saved source is ambiguous.");
  }
  return identifiers.values().next().value ?? null;
}
