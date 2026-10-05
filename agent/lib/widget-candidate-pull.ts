/** Operator-only run-store paging and durable conversion recovery. */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type Candidate,
  type CandidateRow,
  candidateRowSchema,
  flagConversations,
  nextPullState,
  pendingCaseName,
  pullStateSchema,
  renderReview,
  type SignalKind,
} from "./widget-candidates.js";

const ROW_LIMIT = 5000;
const COMMIT_LAG_MS = 60_000;
const RUN_ID = /^wrun_[0-9A-Z]{26}$/;
const conversionsSchema = z.record(
  z.string().regex(RUN_ID),
  z.enum(["pending", "leak_refused"])
);

export type ConversionFailure =
  | "timeout"
  | "leak_refused"
  | "format_failed"
  | "inspect_failed";

/** Child text is private diagnostic data, never terminal output. */
export function conversionFailure(error: unknown): ConversionFailure {
  const result = error as { code?: unknown; killed?: boolean } | null;
  if (result?.code === 3) {
    return "leak_refused";
  }
  if (result?.killed || result?.code === "ETIMEDOUT") {
    return "timeout";
  }
  return result?.code === 4 ? "format_failed" : "inspect_failed";
}

export const CANDIDATE_PAGE_QUERY = `
WITH conversations AS (
  SELECT organization_id, conversation_id, count(*) AS runs
  FROM widget_support_runs
  WHERE completed_at <= $5 AND scope->>'source' IS DISTINCT FROM 'inbox'
    AND NOT (organization_id = ANY($2::uuid[]))
    AND ($3::uuid IS NULL OR (organization_id, conversation_id) > ($3::uuid, $4::uuid))
    AND (organization_id, conversation_id) IN (
      SELECT organization_id, conversation_id FROM widget_support_runs
      WHERE completed_at >= $1 AND completed_at <= $5 AND scope->>'source' IS DISTINCT FROM 'inbox'
        AND NOT (organization_id = ANY($2::uuid[])))
  GROUP BY organization_id, conversation_id
), budgeted AS (
  SELECT *, sum(runs) OVER (ORDER BY organization_id, conversation_id ROWS UNBOUNDED PRECEDING) AS total,
    row_number() OVER (ORDER BY organization_id, conversation_id) AS position
  FROM conversations
)
SELECT id, organization_id, conversation_id, question, scope, session_id, findings,
  decision, outcome, created_at, completed_at
FROM widget_support_runs
WHERE completed_at <= $5 AND scope->>'source' IS DISTINCT FROM 'inbox'
  AND NOT (organization_id = ANY($2::uuid[]))
  AND (organization_id, conversation_id) IN (
    SELECT organization_id, conversation_id FROM budgeted WHERE total <= ${ROW_LIMIT} OR position = 1)
ORDER BY organization_id, conversation_id, created_at, id LIMIT ${ROW_LIMIT + 1}`;

type Query = (sql: string, params: unknown[]) => Promise<unknown[]>;
interface PullDependencies {
  convert: (
    sessionId: string,
    name: string,
    directory: string
  ) => Promise<void>;
  log: (message: string) => void;
  query: Query;
}
interface PullOptions {
  excluded: Set<string>;
  pendingDirectory: string;
  reviewDirectory: string;
  since?: string;
}

const readJson = async (path: string, fallback: unknown): Promise<unknown> =>
  existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : fallback;

const saveJson = async (path: string, value: unknown) => {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
};

async function* candidatePages(
  query: Query,
  since: string,
  excluded: Set<string>
) {
  let cursor: [string, string] | null = null;
  // completed_at is stamped by a single-statement UPDATE at its transaction start.
  // Reading only runs stamped a minute ago means none can still commit behind a
  // conversation this pull already paged, so the watermark never skips one.
  // This assumes the operator's clock agrees with the database's within the lag.
  const until = new Date(Date.now() - COMMIT_LAG_MS).toISOString();
  do {
    const rows = z.array(candidateRowSchema).parse(
      // biome-ignore lint/performance/noAwaitInLoops: each page follows the previous complete conversation.
      await query(CANDIDATE_PAGE_QUERY, [
        since,
        [...excluded],
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        until,
      ])
    );
    if (rows.length > ROW_LIMIT) {
      throw new Error(
        "One conversation exceeds the 5000-run safety bound. Pull cursor was not advanced."
      );
    }
    if (!rows.length) {
      break;
    }
    yield rows;
    const last = rows.at(-1);
    cursor = last ? [last.organization_id, last.conversation_id] : null;
  } while (cursor);
}

async function convertPending(
  options: PullOptions,
  deps: PullDependencies,
  conversions: z.infer<typeof conversionsSchema>,
  conversionsPath: string
) {
  const summary = { converted: 0, refused: 0 };
  for (const [sessionId, status] of Object.entries(conversions)) {
    if (status !== "pending") {
      continue;
    }
    const name = pendingCaseName(sessionId);
    if (existsSync(join(options.pendingDirectory, `${name}.json`))) {
      delete conversions[sessionId];
    } else {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one production decrypt at a time bounds CLI load.
        await deps.convert(sessionId, name, options.pendingDirectory);
        delete conversions[sessionId];
        summary.converted += 1;
        deps.log(`Converted ${sessionId}.`);
      } catch (error) {
        const failure = conversionFailure(error);
        if (failure === "leak_refused") {
          conversions[sessionId] = "leak_refused";
        }
        const detail = error as { stderr?: string; stdout?: string } | null;
        await saveJson(join(options.reviewDirectory, `${name}-failure.json`), {
          error: String(error),
          failure,
          sessionId,
          stderr: detail?.stderr,
          stdout: detail?.stdout,
        });
        deps.log(`Not converted ${sessionId}: ${failure}.`);
        summary.refused += 1;
      }
    }
    await saveJson(conversionsPath, conversions);
  }
  return summary;
}

const recordCandidates = (
  candidates: Candidate[],
  conversions: z.infer<typeof conversionsSchema>,
  bySignal: Partial<Record<SignalKind, number>>
) => {
  for (const candidate of candidates) {
    for (const kind of new Set(
      candidate.signals.map((signal) => signal.kind)
    )) {
      bySignal[kind] = (bySignal[kind] ?? 0) + 1;
    }
    for (const sessionId of candidate.investigationSessions) {
      if (!(sessionId in conversions)) {
        conversions[sessionId] = "pending";
      }
    }
  }
};

export async function pullCandidates(
  options: PullOptions,
  deps: PullDependencies
) {
  const statePath = join(options.reviewDirectory, "state.json");
  const conversionsPath = join(options.reviewDirectory, "conversions.json");
  const previous = pullStateSchema
    .nullable()
    .parse(await readJson(statePath, null));
  const conversions = conversionsSchema.parse(
    await readJson(conversionsPath, {})
  );
  const since = options.since ?? previous?.through;
  if (!since) {
    throw new Error(
      "Pass --since <ISO date> until the first pull is recorded."
    );
  }
  const seen = new Set(options.since ? [] : (previous?.seen ?? []));
  const summary = {
    bySignal: {} as Partial<Record<SignalKind, number>>,
    conversations: 0,
    converted: 0,
    flagged: 0,
    refused: 0,
  };
  let next = previous;
  for await (const rows of candidatePages(
    deps.query,
    since,
    options.excluded
  )) {
    const fresh = (row: CandidateRow) =>
      row.completed_at.toISOString() >= since && !seen.has(row.id);
    summary.conversations += new Set(
      rows
        .filter(fresh)
        .map((row) => `${row.organization_id}/${row.conversation_id}`)
    ).size;
    const candidates = flagConversations(rows, {
      excluded: options.excluded,
      isNew: fresh,
    });
    summary.flagged += candidates.length;
    recordCandidates(candidates, conversions, summary.bySignal);
    if (candidates.length) {
      const pulledAt = new Date().toISOString();
      const review = join(
        options.reviewDirectory,
        `review-${pulledAt.replaceAll(":", "-")}-${summary.flagged}.md`
      );
      await writeFile(review, renderReview(candidates, pulledAt));
      deps.log(`Wrote ${review}: ${candidates.length} flagged conversations.`);
    }
    await saveJson(conversionsPath, conversions);
    const pageState = nextPullState(rows, null);
    if (pageState && (!next || pageState.through >= next.through)) {
      next = nextPullState(rows, next);
    }
  }
  if (next) {
    await saveJson(statePath, next);
  }

  Object.assign(
    summary,
    await convertPending(options, deps, conversions, conversionsPath)
  );
  deps.log(`Pull summary: ${JSON.stringify(summary)}`);
  return summary;
}
