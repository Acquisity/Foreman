import { randomUUID } from "node:crypto";
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

export type ClaimResult =
  | { attempts: number; ok: true; token: string }
  | { ok: false; reason: "backing_off" | "busy" };

export interface Sweep {
  after: string;
  since: number;
  startedAt: number;
}

export interface DiscoveryCursor {
  since: number | null;
  sweep: Sweep | null;
}

export interface ReporterStore {
  anyWaiting: () => Promise<boolean>;
  claim: (
    issue: string,
    stage: Stage,
    message: string,
    channel: string | null
  ) => Promise<ClaimResult>;
  complete: (
    issue: string,
    stage: Stage,
    covers: Stage[],
    message: string,
    channel: string | null,
    commentId: string,
    token: string
  ) => Promise<boolean>;
  enqueue: (issues: string[]) => Promise<void>;
  failPending: (issue: string) => Promise<void>;
  markSent: (
    issue: string,
    stages: Stage[],
    message: string,
    channel: string | null,
    commentId: string
  ) => Promise<void>;
  markWaiting: (issue: string, checkedSha: string | null) => Promise<void>;
  nextPending: (limit: number) => Promise<string[]>;
  queueWaiting: (liveSha: string) => Promise<void>;
  readCursor: () => Promise<DiscoveryCursor>;
  release: (issue: string, stage: Stage, token: string) => Promise<void>;
  resolvePending: (issue: string) => Promise<void>;
  rows: (issue: string) => Promise<LedgerRow[]>;
  saveCursor: (ms: number) => Promise<void>;
  saveSweep: (sweep: Sweep) => Promise<void>;
}

const ROW_STAGE = z.enum(STAGES as [Stage, ...Stage[]]);
const rowSchema = z.object({
  checked_sha: z.string().nullable(),
  comment_id: z.string().nullable(),
  stage: ROW_STAGE,
  status: z.enum(["claimed", "sent", "waiting"]),
});
const issueSchema = z.object({ issue: z.string() });
const cursorSchema = z.object({
  after: z.string().nullable(),
  since: z.coerce.number().nullable(),
  sweep_since: z.coerce.number().nullable(),
  sweep_started: z.coerce.number().nullable(),
});

const STALE_CLAIM = "10 minutes";
export const GIVE_UP_LOG_ATTEMPTS = 5;
const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_MAX_HOURS = 6;
const BACKOFF_EXPONENT_LIMIT = 20;
const BACKOFF = (attempts: string) =>
  `LEAST(interval '${BACKOFF_MAX_HOURS} hours', interval '${BACKOFF_BASE_MINUTES} minutes' * power(2, LEAST(${attempts}, ${BACKOFF_EXPONENT_LIMIT})))`;

export const backoffMs = (attempts: number): number =>
  Math.min(
    BACKOFF_MAX_HOURS * 3_600_000,
    BACKOFF_BASE_MINUTES *
      60_000 *
      2 ** Math.min(attempts, BACKOFF_EXPONENT_LIMIT)
  );

export const createReporterStore = (query: Query): ReporterStore => {
  const store: ReporterStore = {
    async anyWaiting() {
      const rows = await query(
        "SELECT 1 FROM reporter_updates WHERE stage = 'fixed' AND status = 'waiting' LIMIT 1",
        []
      );
      return rows.length > 0;
    },
    async claim(issue, stage, message, channel) {
      const token = randomUUID();
      const rows = await query(
        `INSERT INTO reporter_updates (issue, stage, status, message, slack_channel, claim_token, claimed_at, attempts)
       VALUES ($1, $2, 'claimed', $3, $4, $5, now(), 1)
       ON CONFLICT (issue, stage) DO UPDATE
         SET status = 'claimed', message = EXCLUDED.message,
             slack_channel = EXCLUDED.slack_channel, claim_token = EXCLUDED.claim_token,
             claimed_at = now(), attempts = reporter_updates.attempts + 1, updated_at = now()
         WHERE (reporter_updates.status = 'waiting'
                AND (reporter_updates.retry_after IS NULL OR reporter_updates.retry_after <= now()))
            OR (reporter_updates.status = 'claimed'
                AND reporter_updates.claimed_at < now() - interval '${STALE_CLAIM}')
       RETURNING claim_token, attempts`,
        [issue, stage, message, channel, token]
      );
      if (rows.length === 1) {
        return { attempts: Number(rows[0]?.attempts), ok: true, token };
      }
      const [current] = await query(
        "SELECT status FROM reporter_updates WHERE issue = $1 AND stage = $2",
        [issue, stage]
      );
      return {
        ok: false,
        reason: current?.status === "waiting" ? "backing_off" : "busy",
      };
    },
    async complete(issue, stage, covers, message, channel, commentId, token) {
      const done = await query(
        `UPDATE reporter_updates
       SET status = 'sent', comment_id = $4, message = $5, claim_token = NULL,
           sent_at = now(), updated_at = now()
       WHERE issue = $1 AND stage = $2 AND claim_token = $3 AND status = 'claimed'
       RETURNING stage`,
        [issue, stage, token, commentId, message]
      );
      if (done.length !== 1) {
        return false;
      }
      const others = covers.filter((covered) => covered !== stage);
      if (others.length > 0) {
        await store.markSent(issue, others, message, channel, commentId);
      }
      return true;
    },
    async enqueue(issues) {
      if (issues.length === 0) {
        return;
      }
      const unique = [...new Set(issues)];
      await query(
        `INSERT INTO reporter_pending (issue) SELECT unnest($1::text[])
         ON CONFLICT (issue) DO UPDATE SET attempts = 0, retry_after = NULL`,
        [unique]
      );
      await query(
        `UPDATE reporter_updates SET attempts = 0, retry_after = NULL, updated_at = now()
         WHERE issue = ANY($1::text[]) AND status = 'waiting'`,
        [unique]
      );
    },
    async failPending(issue) {
      await query(
        `UPDATE reporter_pending
         SET attempts = attempts + 1, last_try = now(), retry_after = now() + ${BACKOFF("attempts")}
         WHERE issue = $1`,
        [issue]
      );
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
    async nextPending(limit) {
      const rows = await query(
        `SELECT issue FROM reporter_pending
         WHERE retry_after IS NULL OR retry_after <= now()
         ORDER BY last_try NULLS FIRST, added_at LIMIT $1`,
        [limit]
      );
      return rows.map((row) => issueSchema.parse(row).issue);
    },
    async queueWaiting(liveSha) {
      await query(
        `INSERT INTO reporter_pending (issue)
         SELECT issue FROM reporter_updates
         WHERE stage = 'fixed' AND status = 'waiting' AND checked_sha IS DISTINCT FROM $1
         ON CONFLICT (issue) DO NOTHING`,
        [liveSha]
      );
    },
    async readCursor() {
      const rows = await query(
        `SELECT (extract(epoch FROM since) * 1000)::bigint::text AS since,
                sweep_after AS after,
                (extract(epoch FROM sweep_since) * 1000)::bigint::text AS sweep_since,
                (extract(epoch FROM sweep_started) * 1000)::bigint::text AS sweep_started
         FROM reporter_cursor WHERE id`,
        []
      );
      if (!rows[0]) {
        return { since: null, sweep: null };
      }
      const row = cursorSchema.parse(rows[0]);
      return {
        since: row.since,
        sweep:
          row.after && row.sweep_since !== null && row.sweep_started !== null
            ? {
                after: row.after,
                since: row.sweep_since,
                startedAt: row.sweep_started,
              }
            : null,
      };
    },
    async release(issue, stage, token) {
      await query(
        `UPDATE reporter_updates
       SET status = 'waiting', claim_token = NULL, claimed_at = NULL, updated_at = now(),
           retry_after = now() + ${BACKOFF("attempts")}
       WHERE issue = $1 AND stage = $2 AND claim_token = $3 AND status = 'claimed'`,
        [issue, stage, token]
      );
    },
    async resolvePending(issue) {
      await query("DELETE FROM reporter_pending WHERE issue = $1", [issue]);
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
    async saveCursor(ms) {
      await query(
        `INSERT INTO reporter_cursor (id, since) VALUES (true, to_timestamp($1::double precision / 1000))
         ON CONFLICT (id) DO UPDATE
           SET since = GREATEST(reporter_cursor.since, EXCLUDED.since),
               sweep_after = NULL, sweep_since = NULL, sweep_started = NULL, updated_at = now()`,
        [ms]
      );
    },
    async saveSweep(sweep) {
      await query(
        `INSERT INTO reporter_cursor (id, sweep_after, sweep_since, sweep_started)
         VALUES (true, $1, to_timestamp($2::double precision / 1000), to_timestamp($3::double precision / 1000))
         ON CONFLICT (id) DO UPDATE
           SET sweep_after = EXCLUDED.sweep_after, sweep_since = EXCLUDED.sweep_since,
               sweep_started = EXCLUDED.sweep_started, updated_at = now()`,
        [sweep.after, sweep.since, sweep.startedAt]
      );
    },
  };
  return store;
};

export const databaseReporterStore = (): ReporterStore =>
  createReporterStore(
    (text, values) =>
      privateDatabase().query(text, values) as Promise<
        Record<string, unknown>[]
      >
  );
