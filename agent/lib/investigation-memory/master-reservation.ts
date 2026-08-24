import { createHash, randomUUID } from "node:crypto";
import type { CausalIdentity } from "../triage-review-packet.js";
import { memoryDatabase } from "./database.js";
import { TENANT_KEY } from "./scope.js";

export const causalFingerprint = (input: CausalIdentity): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.repositoryKey,
        input.failingInvariantKey,
        [...input.causalPathKeys].sort(),
        [...input.triggerConditionKeys].sort(),
        input.preventionOutcomeKey,
      ])
    )
    .digest("hex");

interface ReservationRow {
  causal_fingerprint: string;
  evidence_revision: string;
  generation_key: string;
  id: string;
  master_created_at: string | null;
  master_issue_id: string | null;
  source_issue_id: string;
  status: "reserved" | "complete";
}

export interface ReservationDatabase {
  query: (statement: string, params?: unknown[]) => Promise<unknown[]>;
}

const reservationDatabase = (): ReservationDatabase => {
  const database = memoryDatabase();
  return {
    query(statement, params = []) {
      return database.query(statement, params);
    },
  };
};

export interface ReserveMasterInput {
  readonly approvalId: string;
  readonly causalIdentity: CausalIdentity;
  readonly eligibilityEvaluatedAt: string;
  readonly evidenceRevision: string;
  readonly generationKey: string;
  readonly masterRecencyPolicy: "THIRTY_DAY" | "UNBOUNDED";
  readonly predecessorCreatedAt?: string;
  readonly reviewAttempt: 1 | 2;
  readonly reviewerModel: string;
  readonly sourceIssueId: string;
}

export type MasterReservation =
  | {
      readonly acquired: true;
      readonly causalFingerprint: string;
      readonly reservationId: string;
    }
  | {
      readonly acquired: false;
      readonly causalFingerprint: string;
      readonly existingMasterIssueId?: string;
      readonly existingMasterCreatedAt?: string;
      readonly reason: "existing_master" | "reservation_in_progress";
    };

const readReservation = async (
  fingerprint: string,
  sql: ReservationDatabase
): Promise<ReservationRow> => {
  const rows = (await sql.query(
    `SELECT id, causal_fingerprint, source_issue_id, evidence_revision,
      master_issue_id, master_created_at, generation_key, status
     FROM triage_master_reservations
     WHERE tenant_key = $1 AND causal_fingerprint = $2`,
    [TENANT_KEY, fingerprint]
  )) as ReservationRow[];
  const [row] = rows;
  if (!row) {
    throw new Error("The master reservation could not be read back.");
  }
  return row;
};

export const reserveMaster = async (
  input: ReserveMasterInput,
  sql: ReservationDatabase = reservationDatabase()
): Promise<MasterReservation> => {
  const fingerprint = causalFingerprint(input.causalIdentity);
  const reservationId = randomUUID();
  let inserted: Array<{ id: string }>;
  if (input.generationKey === "initial") {
    inserted = (await sql.query(
      `INSERT INTO triage_master_reservations (
        id, tenant_key, causal_fingerprint, source_issue_id, critic_approval_id,
        evidence_revision, reviewer_model, review_attempt, generation_key,
        master_recency_policy, eligibility_evaluated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tenant_key, causal_fingerprint) DO NOTHING
      RETURNING id`,
      [
        reservationId,
        TENANT_KEY,
        fingerprint,
        input.sourceIssueId,
        input.approvalId,
        input.evidenceRevision,
        input.reviewerModel,
        input.reviewAttempt,
        input.generationKey,
        input.masterRecencyPolicy,
        input.eligibilityEvaluatedAt,
      ]
    )) as Array<{ id: string }>;
  } else {
    if (input.masterRecencyPolicy !== "THIRTY_DAY") {
      throw new Error(
        "Only 30-day intake may advance a stale master generation."
      );
    }
    if (
      input.predecessorCreatedAt === undefined ||
      Date.parse(input.predecessorCreatedAt) >=
        Date.parse(input.eligibilityEvaluatedAt) - 30 * 24 * 60 * 60 * 1000
    ) {
      throw new Error("The reviewed predecessor is not more than 30 days old.");
    }
    inserted = (await sql.query(
      `UPDATE triage_master_reservations
       SET id = $1, source_issue_id = $4, critic_approval_id = $5,
         evidence_revision = $6, reviewer_model = $7, review_attempt = $8,
         generation_key = $9, master_recency_policy = $10,
         eligibility_evaluated_at = $11, master_issue_id = NULL,
         master_created_at = NULL, status = 'reserved', updated_at = now()
       WHERE tenant_key = $2 AND causal_fingerprint = $3
         AND status = 'complete' AND master_issue_id = $9
         AND master_created_at < $11::timestamptz - interval '30 days'
       RETURNING id`,
      [
        reservationId,
        TENANT_KEY,
        fingerprint,
        input.sourceIssueId,
        input.approvalId,
        input.evidenceRevision,
        input.reviewerModel,
        input.reviewAttempt,
        input.generationKey,
        input.masterRecencyPolicy,
        input.eligibilityEvaluatedAt,
      ]
    )) as Array<{ id: string }>;
    if (inserted.length === 0) {
      inserted = (await sql.query(
        `INSERT INTO triage_master_reservations (
          id, tenant_key, causal_fingerprint, source_issue_id,
          critic_approval_id, evidence_revision, reviewer_model,
          review_attempt, generation_key, master_recency_policy,
          eligibility_evaluated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (tenant_key, causal_fingerprint) DO NOTHING
        RETURNING id`,
        [
          reservationId,
          TENANT_KEY,
          fingerprint,
          input.sourceIssueId,
          input.approvalId,
          input.evidenceRevision,
          input.reviewerModel,
          input.reviewAttempt,
          input.generationKey,
          input.masterRecencyPolicy,
          input.eligibilityEvaluatedAt,
        ]
      )) as Array<{ id: string }>;
    }
  }

  if (inserted.length === 1) {
    return {
      acquired: true,
      causalFingerprint: fingerprint,
      reservationId,
    };
  }

  const row = await readReservation(fingerprint, sql);
  if (row.status === "complete" && row.master_issue_id) {
    return {
      acquired: false,
      causalFingerprint: fingerprint,
      existingMasterCreatedAt: row.master_created_at ?? undefined,
      existingMasterIssueId: row.master_issue_id,
      reason: "existing_master",
    };
  }

  return {
    acquired: false,
    causalFingerprint: fingerprint,
    reason: "reservation_in_progress",
  };
};

export const completeMasterReservation = async (
  reservationId: string,
  masterIssueId: string,
  masterCreatedAt: string,
  sql: ReservationDatabase = reservationDatabase()
): Promise<boolean> => {
  const rows = (await sql.query(
    `UPDATE triage_master_reservations
     SET master_issue_id = $1, master_created_at = $2, status = 'complete', updated_at = now()
     WHERE tenant_key = $3 AND id = $4 AND status = 'reserved'
     RETURNING id`,
    [masterIssueId, masterCreatedAt, TENANT_KEY, reservationId]
  )) as Array<{ id: string }>;
  return rows.length === 1;
};
