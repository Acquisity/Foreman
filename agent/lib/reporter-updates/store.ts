import { z } from "zod";
import { privateDatabase } from "../private-postgres.js";
import { STAGES, type Stage } from "./copy.js";

export type Query = (
  text: string,
  values: unknown[]
) => Promise<Record<string, unknown>[]>;

export interface LedgerRow {
  checkedSha: string | null;
  commentId: string | null;
  stage: Stage;
  status: "claimed" | "sent" | "waiting";
}

export interface WaitingTicket {
  checkedSha: string | null;
  issue: string;
}

export interface ReporterStore {
  claim: (
    issue: string,
    stage: Stage,
    message: string,
    channel: string | null
  ) => Promise<boolean>;
  listWaiting: () => Promise<WaitingTicket[]>;
  markSent: (
    issue: string,
    stages: Stage[],
    message: string,
    channel: string | null,
    commentId: string
  ) => Promise<void>;
  markWaiting: (issue: string, checkedSha: string | null) => Promise<void>;
  release: (issue: string, stage: Stage) => Promise<void>;
  rows: (issue: string) => Promise<LedgerRow[]>;
}

const ROW_STAGE = z.enum(STAGES as [Stage, ...Stage[]]);
const rowSchema = z.object({
  checked_sha: z.string().nullable(),
  comment_id: z.string().nullable(),
  stage: ROW_STAGE,
  status: z.enum(["claimed", "sent", "waiting"]),
});
const waitingSchema = z.object({
  checked_sha: z.string().nullable(),
  issue: z.string(),
});

const STALE_CLAIM = "10 minutes";

export const createReporterStore = (query: Query): ReporterStore => ({
  async claim(issue, stage, message, channel) {
    const rows = await query(
      `INSERT INTO reporter_updates (issue, stage, status, message, slack_channel, claimed_at)
       VALUES ($1, $2, 'claimed', $3, $4, now())
       ON CONFLICT (issue, stage) DO UPDATE
         SET status = 'claimed', message = EXCLUDED.message,
             slack_channel = EXCLUDED.slack_channel, claimed_at = now(), updated_at = now()
         WHERE reporter_updates.status = 'waiting'
            OR (reporter_updates.status = 'claimed'
                AND reporter_updates.claimed_at < now() - interval '${STALE_CLAIM}')
       RETURNING issue`,
      [issue, stage, message, channel]
    );
    return rows.length === 1;
  },
  async listWaiting() {
    const rows = await query(
      `SELECT issue, checked_sha FROM reporter_updates
       WHERE stage = 'fixed' AND status = 'waiting'
       ORDER BY updated_at LIMIT 200`,
      []
    );
    return rows.map((row) => {
      const parsed = waitingSchema.parse(row);
      return { checkedSha: parsed.checked_sha, issue: parsed.issue };
    });
  },
  async markSent(issue, stages, message, channel, commentId) {
    await query(
      `INSERT INTO reporter_updates (issue, stage, status, message, slack_channel, comment_id, sent_at)
       SELECT $1, stage, 'sent', $3, $4, $5, now() FROM unnest($2::text[]) AS stage
       ON CONFLICT (issue, stage) DO UPDATE
         SET status = 'sent', message = EXCLUDED.message, comment_id = EXCLUDED.comment_id,
             sent_at = now(), updated_at = now()`,
      [issue, stages, message, channel, commentId]
    );
  },
  async markWaiting(issue, checkedSha) {
    await query(
      `INSERT INTO reporter_updates (issue, stage, status, checked_sha)
       VALUES ($1, 'fixed', 'waiting', $2)
       ON CONFLICT (issue, stage) DO UPDATE
         SET checked_sha = EXCLUDED.checked_sha, updated_at = now()
         WHERE reporter_updates.status = 'waiting'`,
      [issue, checkedSha]
    );
  },
  async release(issue, stage) {
    await query(
      `UPDATE reporter_updates SET status = 'waiting', claimed_at = NULL, updated_at = now()
       WHERE issue = $1 AND stage = $2 AND status = 'claimed'`,
      [issue, stage]
    );
  },
  async rows(issue) {
    const rows = await query(
      "SELECT stage, status, checked_sha, comment_id FROM reporter_updates WHERE issue = $1",
      [issue]
    );
    return rows.map((row) => {
      const parsed = rowSchema.parse(row);
      return {
        checkedSha: parsed.checked_sha,
        commentId: parsed.comment_id,
        stage: parsed.stage,
        status: parsed.status,
      };
    });
  },
});

export const databaseReporterStore = (): ReporterStore =>
  createReporterStore(
    (text, values) =>
      privateDatabase().query(text, values) as Promise<
        Record<string, unknown>[]
      >
  );
