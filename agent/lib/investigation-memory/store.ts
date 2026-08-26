import { createHash, randomUUID } from "node:crypto";
import { type NeonQueryFunction, neon } from "@neondatabase/serverless";
import type {
  CasePayload,
  CaseProjection,
  CaseStatus,
  Classification,
  Confidence,
} from "./case.js";
import { searchText } from "./case.js";
import {
  type FeatureKey,
  isFeatureKey,
  LIVE_FEATURE_KEYS,
  TENANT_KEY,
} from "./scope.js";

/**
 * The investigation-memory database: Foreman's own private Postgres, reached
 * with server-side credentials that never enter a model message, a tool
 * schema, a tool result, or the sandbox.
 *
 * @remarks
 * This is not customer data and not production evidence. PlanetScale remains
 * the only production database a triage investigation reads, and the
 * user-scoped `neon__*` MCP connection is unrelated to this and must not be
 * used for memory.
 *
 * The tenant is a module constant. It is never taken from model input, never
 * from an environment variable, and never from the session.
 */

/** Default number of cases handed back to the model. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** Hard ceiling on cases handed back, whatever the model asks for. */
export const MAX_SEARCH_LIMIT = 10;

/** How far back a search looks by default, in days. */
export const DEFAULT_SEARCH_WINDOW_DAYS = 365;

/**
 * The window a possible-wider-incident signal is counted over, and how many
 * independent tickets it takes to raise one.
 *
 * @remarks
 * Chosen as a starting point, not a measured threshold: three separate tickets
 * inside two weeks is more than coincidence and less than an outage. It is a
 * prompt to check current telemetry, never a declaration.
 */
export const CLUSTER_WINDOW_DAYS = 14;
export const CLUSTER_MIN_REPORTS = 3;

/** The store could not be reached. Never a reason to hold a ticket. */
export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

let client: NeonQueryFunction<false, false> | null = null;

function db(): NeonQueryFunction<false, false> {
  if (client !== null) {
    return client;
  }
  const url = process.env.FOREMAN_MEMORY_DATABASE_URL;
  if (!url) {
    throw new MemoryUnavailableError(
      "FOREMAN_MEMORY_DATABASE_URL is not set, so investigation memory is unavailable."
    );
  }
  client = neon(url);
  return client;
}

/** Whether the deployment has an investigation-memory database configured. */
export const isConfigured = (): boolean =>
  typeof process.env.FOREMAN_MEMORY_DATABASE_URL === "string" &&
  process.env.FOREMAN_MEMORY_DATABASE_URL !== "";

/**
 * The deterministic key that makes a write replay-safe.
 *
 * @remarks
 * A step that is interrupted after the insert and re-run must land on the same
 * key, so it is derived from what identifies the write: the source ticket, the
 * final classification, the root cause, and, for a correction, the exact case
 * it supersedes. The predecessor keeps a correction replay-safe without
 * preventing a later revision from returning to an earlier conclusion.
 */
export function idempotencyKey(
  sourceIssueId: string,
  classification: Classification,
  rootCause: string,
  supersedesCaseId?: string
): string {
  // Keep the original record-key encoding so deployed first revisions remain
  // replay-safe. Corrections use a separate structured namespace so their
  // predecessor cannot be confused with text at the end of the root cause.
  const material =
    supersedesCaseId === undefined
      ? `${sourceIssueId}|${classification}|${rootCause}`
      : JSON.stringify([
          "correction",
          sourceIssueId,
          classification,
          rootCause,
          supersedesCaseId,
        ]);
  return createHash("sha256").update(material).digest("hex");
}

type DatabaseDate = Date | string;

/** A row as selected for the model projection. */
export interface CaseRow {
  affected_feature_keys: string[];
  affected_org_count: number | null;
  affected_user_count: number | null;
  claim: string;
  classification: Classification;
  component: string | null;
  confidence: Confidence;
  counted_at: DatabaseDate | null;
  created_at: DatabaseDate;
  dependency_keys: string[];
  evidence_refs: string[];
  id: string;
  observed_from: DatabaseDate | null;
  observed_to: DatabaseDate | null;
  primary_feature_key: string;
  provider: string | null;
  resolution: string | null;
  root_cause: string;
  scope_rank?: number;
  source_document_url: string | null;
  source_issue_id: string;
  source_issue_url: string;
  supersedes_case_id: string | null;
}

const PROJECTION_COLUMNS = `id, primary_feature_key, affected_feature_keys, dependency_keys,
  component, provider, classification, claim, root_cause, resolution,
  source_issue_id, source_issue_url, source_document_url, evidence_refs,
  affected_org_count, affected_user_count, counted_at, confidence,
  supersedes_case_id, observed_from, observed_to, created_at`;

const toIso = (value: DatabaseDate | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const toDateOnly = (value: DatabaseDate | null): string | null =>
  value === null
    ? null
    : (value instanceof Date ? value.toISOString() : value).slice(0, 10);

function matchReason(
  row: CaseRow,
  feature: FeatureKey
): CaseProjection["matchedOn"] {
  if (row.primary_feature_key === feature) {
    return "primary_feature";
  }
  return row.affected_feature_keys.includes(feature)
    ? "affected_feature"
    : "dependency";
}

export function projectCase(row: CaseRow, feature: FeatureKey): CaseProjection {
  const matchedOn = matchReason(row, feature);
  return {
    affectedFeatureKeys: row.affected_feature_keys,
    affectedOrgCount: row.affected_org_count,
    affectedUserCount: row.affected_user_count,
    caseId: row.id,
    claim: row.claim,
    classification: row.classification,
    component: row.component,
    confidence: row.confidence,
    correctsEarlierConclusion: row.supersedes_case_id !== null,
    countedAt: toDateOnly(row.counted_at),
    dependencyKeys: row.dependency_keys,
    evidenceRefs: row.evidence_refs,
    matchedOn,
    observedFrom: toIso(row.observed_from),
    observedTo: toIso(row.observed_to),
    primaryFeatureKey: row.primary_feature_key,
    provider: row.provider,
    recordedAt: new Date(row.created_at).toISOString(),
    resolution: row.resolution,
    rootCause: row.root_cause,
    sourceDocumentUrl: row.source_document_url,
    sourceIssueId: row.source_issue_id,
    sourceIssueUrl: row.source_issue_url,
  };
}

/** Independent recent reports in the same scope: a signal, never a verdict. */
export interface ClusterSignal {
  distinctFeatures: number;
  firstSeen: string | null;
  lastSeen: string | null;
  possibleWiderIncident: boolean;
  reports: number;
  windowDays: number;
}

/** A wider-incident signal isolated to one product area. */
export interface FeatureClusterSignal extends ClusterSignal {
  primaryFeatureKey: FeatureKey;
}

/** Project-independent retrieval across server-selected live product areas. */
export interface GlobalSearchResult {
  cases: CaseProjection[];
  clusters: FeatureClusterSignal[];
}

/** Relevance inputs for authorized investigation-memory retrieval. */
export interface GlobalSearchParams {
  classification?: Classification;
  component?: string;
  dependencyKeys?: readonly string[];
  limit?: number;
  provider?: string;
  sourceIssueId?: string;
  text?: string;
  windowDays?: number;
}

/** Database-independent cluster counts, exposed so grouping stays testable. */
export interface FeatureClusterCounts {
  distinctFeatures: number;
  firstSeen: string | null;
  lastSeen: string | null;
  primaryFeatureKey: FeatureKey;
  reports: number;
}

/**
 * Turn per-product counts into signals without ever combining their reports.
 */
export function featureClusterSignalsFromCounts(
  rows: readonly FeatureClusterCounts[]
): FeatureClusterSignal[] {
  return rows.map((counts) => ({
    distinctFeatures: counts.distinctFeatures,
    firstSeen: toIso(counts.firstSeen),
    lastSeen: toIso(counts.lastSeen),
    possibleWiderIncident: counts.reports >= CLUSTER_MIN_REPORTS,
    primaryFeatureKey: counts.primaryFeatureKey,
    reports: counts.reports,
    windowDays: CLUSTER_WINDOW_DAYS,
  }));
}

const GLOBAL_SEARCH_SQL = `SELECT ${PROJECTION_COLUMNS},
    CASE WHEN dependency_keys && $3::text[] THEN 1 ELSE 0 END AS dependency_rank,
    CASE WHEN $4::text IS NOT NULL AND component = $4 THEN 1 ELSE 0 END AS component_rank,
    CASE WHEN $5::text IS NOT NULL AND provider = $5 THEN 1 ELSE 0 END AS provider_rank,
    CASE WHEN $7::text IS NULL THEN 0
         ELSE ts_rank(search_document, websearch_to_tsquery('english', $7))
    END AS text_rank
  FROM investigation_cases
  WHERE tenant_key = $1
    AND status = 'active'
    -- A ticket lookup ($10) is an identity question, not a relevance search.
    -- It is project-independent and bypasses product lifecycle, relevance,
    -- classification, and time-window filters so a correction can always find
    -- the ticket's active case.
    AND ($10::text IS NULL OR source_issue_id = $10)
    AND ($10::text IS NOT NULL OR primary_feature_key = ANY ($2::text[]))
    AND ($10::text IS NOT NULL OR $6::text IS NULL OR classification = $6)
    AND ($10::text IS NOT NULL
      OR created_at >= now() - ($8::int * INTERVAL '1 day'))
  ORDER BY component_rank DESC, provider_rank DESC, dependency_rank DESC,
    text_rank DESC, created_at DESC
  LIMIT $9`;

export const GLOBAL_CLUSTER_SQL = `SELECT
    primary_feature_key,
    count(DISTINCT source_issue_id)::int AS reports,
    count(DISTINCT primary_feature_key)::int AS distinct_features,
    min(created_at) AS first_seen,
    max(created_at) AS last_seen
  FROM investigation_cases
  WHERE tenant_key = $1
    AND status = 'active'
    AND primary_feature_key = ANY ($2::text[])
    AND ($3::text IS NULL OR component = $3)
    AND (cardinality($4::text[]) = 0 OR dependency_keys && $4::text[])
    AND created_at >= now() - ($5::int * INTERVAL '1 day')
  GROUP BY primary_feature_key`;

interface ClusterRow {
  distinct_features: number;
  first_seen: DatabaseDate | null;
  last_seen: DatabaseDate | null;
  primary_feature_key?: string;
  reports: number;
}

/**
 * Search every live product area without consulting Linear project metadata.
 *
 * @remarks
 * The feature list comes directly from the server-owned live lifecycle table.
 * Search results may span areas, but cluster counts are grouped before they
 * leave Postgres. When intake has not identified a component or dependency
 * yet, cluster signaling is suppressed rather than treating all recent cases
 * in an area as one incident. A source-issue lookup is an identity query and
 * bypasses lifecycle, relevance, and time-window filters.
 */
export async function searchCasesGlobally(
  params: GlobalSearchParams
): Promise<GlobalSearchResult> {
  const sql = db();
  const featureKeys = [...LIVE_FEATURE_KEYS];

  const limit = Math.min(
    Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1),
    MAX_SEARCH_LIMIT
  );
  const dependencies = [...(params.dependencyKeys ?? [])];
  const component = params.component ?? null;
  const provider = params.provider ?? null;
  const text = params.text?.trim() ? params.text.trim() : null;
  const windowDays = params.windowDays ?? DEFAULT_SEARCH_WINDOW_DAYS;
  const canGroupIncident =
    params.sourceIssueId === undefined &&
    (component !== null || dependencies.length > 0);

  const queries = [
    sql.query(GLOBAL_SEARCH_SQL, [
      TENANT_KEY,
      featureKeys,
      dependencies,
      component,
      provider,
      params.classification ?? null,
      text,
      windowDays,
      limit,
      params.sourceIssueId ?? null,
    ]),
  ];
  if (canGroupIncident) {
    queries.push(
      sql.query(GLOBAL_CLUSTER_SQL, [
        TENANT_KEY,
        featureKeys,
        component,
        dependencies,
        CLUSTER_WINDOW_DAYS,
      ])
    );
  }

  const [rows, clusterRows = []] = (await sql.transaction(queries)) as [
    CaseRow[],
    ClusterRow[]?,
  ];
  const cases = rows.map((row) => {
    if (!isFeatureKey(row.primary_feature_key)) {
      throw new MemoryUnavailableError(
        "Investigation memory returned an unknown product area."
      );
    }
    return projectCase(row, row.primary_feature_key);
  });
  const clusterCounts: FeatureClusterCounts[] = clusterRows.flatMap((row) => {
    if (!(row.primary_feature_key && isFeatureKey(row.primary_feature_key))) {
      return [];
    }
    return [
      {
        distinctFeatures: row.distinct_features,
        firstSeen: toIso(row.first_seen),
        lastSeen: toIso(row.last_seen),
        primaryFeatureKey: row.primary_feature_key,
        reports: row.reports,
      },
    ];
  });

  return {
    cases,
    clusters: featureClusterSignalsFromCounts(clusterCounts),
  };
}

const INSERT_BODY = `INSERT INTO investigation_cases (
    id, tenant_key, primary_feature_key, affected_feature_keys, dependency_keys,
    linear_project_id, component, provider, source_issue_id, source_issue_url,
    source_document_url, revision, classification, claim, symptoms,
    error_signatures, code_paths, commit_sha, root_cause, resolution, ruled_out,
    evidence_refs, affected_org_count, affected_user_count, counted_at,
    confidence, status, supersedes_case_id, correction_reason, observed_from,
    observed_to, idempotency_key, search_document
  ) VALUES (
    $1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15::text[],
    $16::text[], $17::text[], $18, $19, $20, $21::text[],
    $22::text[], $23, $24, $25::date,
    $26, 'active', $27, $28, $29::timestamptz,
    $30::timestamptz, $31, to_tsvector('english', $32)
  )`;

/** Recording: a replay of the same conclusion is a no-op, not an error. */
const INSERT_SQL = `${INSERT_BODY}
  ON CONFLICT (tenant_key, idempotency_key) DO NOTHING
  RETURNING id`;

/**
 * Correcting: no conflict clause, so a duplicate aborts the whole transaction
 * rather than superseding a case without inserting its replacement.
 */
const INSERT_STRICT_SQL = `${INSERT_BODY}
  RETURNING id`;

function insertParams(
  id: string,
  feature: FeatureKey,
  payload: CasePayload,
  classification: Classification,
  options: {
    correctionReason: string | null;
    revision: number;
    supersedesCaseId: string | null;
  }
): unknown[] {
  return [
    id,
    TENANT_KEY,
    feature,
    payload.affectedFeatureKeys,
    payload.dependencyKeys,
    payload.linearProjectId ?? null,
    payload.component ?? null,
    payload.provider ?? null,
    payload.sourceIssueId,
    payload.sourceIssueUrl,
    payload.sourceDocumentUrl ?? null,
    options.revision,
    classification,
    payload.claim,
    payload.symptoms,
    payload.errorSignatures,
    payload.codePaths,
    payload.commitSha ?? null,
    payload.rootCause,
    payload.resolution ?? null,
    payload.ruledOut,
    payload.evidenceRefs,
    payload.affectedOrgCount ?? null,
    payload.affectedUserCount ?? null,
    payload.countedAt ?? null,
    payload.confidence,
    options.supersedesCaseId,
    options.correctionReason,
    payload.observedFrom ?? null,
    payload.observedTo ?? null,
    idempotencyKey(
      payload.sourceIssueId,
      classification,
      payload.rootCause,
      options.supersedesCaseId ?? undefined
    ),
    searchText(payload),
  ];
}

/** What a write returns: the stored case, or why it was not stored. */
export type WriteResult =
  | { caseId: string; created: true; revision: number }
  | { caseId: string; created: false; reason: "already_recorded" }
  | { created: false; existingCaseId: string; reason: "active_case_exists" };

/** Names of the constraints that mean "this ticket already has a live case". */
const ACTIVE_CASE_CONSTRAINTS = [
  "investigation_cases_one_active",
  "investigation_cases_revision_unique",
];

/** Whether a driver error is the one-active-case conflict rather than anything else. */
function isActiveCaseConflict(error: unknown): boolean {
  if (error instanceof Error) {
    return ACTIVE_CASE_CONSTRAINTS.some((name) => error.message.includes(name));
  }
  return false;
}

async function caseIdFor(
  sql: NeonQueryFunction<false, false>,
  key: string
): Promise<string | null> {
  const rows = (await sql.query(
    "SELECT id FROM investigation_cases WHERE tenant_key = $1 AND idempotency_key = $2",
    [TENANT_KEY, key]
  )) as { id: string }[];
  return rows[0]?.id ?? null;
}

async function legacyCorrectionIdFor(
  sql: NeonQueryFunction<false, false>,
  key: string,
  supersedesCaseId: string
): Promise<string | null> {
  const rows = (await sql.query(
    "SELECT id FROM investigation_cases WHERE tenant_key = $1 AND idempotency_key = $2 AND supersedes_case_id = $3",
    [TENANT_KEY, key, supersedesCaseId]
  )) as { id: string }[];
  return rows[0]?.id ?? null;
}

async function activeCase(
  sql: NeonQueryFunction<false, false>,
  sourceIssueId: string
): Promise<{ id: string; revision: number } | null> {
  const rows = (await sql.query(
    "SELECT id, revision FROM investigation_cases WHERE tenant_key = $1 AND source_issue_id = $2 AND status = 'active'",
    [TENANT_KEY, sourceIssueId]
  )) as { id: string; revision: number }[];
  return rows[0] ?? null;
}

/**
 * Records a completed investigation as the first active case for its ticket.
 *
 * @remarks
 * Refuses when that ticket already has an active case, rather than quietly
 * writing a second truth: overturning an earlier conclusion is a correction,
 * and corrections go through {@link correctCase} so the history survives. A
 * replay of the same conclusion is a no-op.
 */
export async function recordCase(
  feature: FeatureKey,
  payload: CasePayload,
  classification: Classification
): Promise<WriteResult> {
  const sql = db();
  const key = idempotencyKey(
    payload.sourceIssueId,
    classification,
    payload.rootCause
  );

  const replay = await caseIdFor(sql, key);
  if (replay !== null) {
    return { caseId: replay, created: false, reason: "already_recorded" };
  }

  const existing = await activeCase(sql, payload.sourceIssueId);
  if (existing !== null) {
    return {
      created: false,
      existingCaseId: existing.id,
      reason: "active_case_exists",
    };
  }

  const id = randomUUID();
  let rows: { id: string }[];
  try {
    rows = (await sql.query(
      INSERT_SQL,
      insertParams(id, feature, payload, classification, {
        correctionReason: null,
        revision: 1,
        supersedesCaseId: null,
      })
    )) as { id: string }[];
  } catch (error) {
    // Another attended session recorded this ticket between the pre-check and
    // the insert. The database is the arbiter, so translate its conflict into
    // the same structured answer the pre-check gives instead of handing the
    // model a raw Postgres error.
    if (isActiveCaseConflict(error)) {
      const winner = await activeCase(sql, payload.sourceIssueId);
      // Only answer "an active case already exists" when one actually does.
      // The revision constraint can also fire against a superseded row, and
      // reporting that as a live case with an empty id would send the model
      // off to correct something it cannot find.
      if (winner) {
        return {
          created: false,
          existingCaseId: winner.id,
          reason: "active_case_exists",
        };
      }
    }
    throw error;
  }
  const [inserted] = rows;
  if (inserted) {
    return { caseId: inserted.id, created: true, revision: 1 };
  }
  // The insert lost a race on the idempotency key: the winner is the case.
  const raced = await caseIdFor(sql, key);
  if (raced === null) {
    throw new MemoryUnavailableError(
      "The case was neither inserted nor found after a conflict."
    );
  }
  return { caseId: raced, created: false, reason: "already_recorded" };
}

/** What a correction returns when the case it names cannot be superseded. */
export type CorrectionResult =
  | {
      caseId: string;
      created: true;
      revision: number;
      supersededCaseId: string;
    }
  | { caseId: string; created: false; reason: "already_recorded" }
  | { created: false; reason: "prior_case_not_active" }
  | { created: false; reason: "prior_case_other_ticket" };

/**
 * Supersedes an earlier conclusion with a new revision.
 *
 * @remarks
 * The insert and the supersession run in one transaction, so a superseded case
 * can never sit alongside its replacement as active, and the partial unique
 * index enforces that even if two corrections race. Nothing is deleted: the
 * old revision stays readable through the chain, and stops counting toward
 * default retrieval and cluster signals.
 */
export async function correctCase(
  feature: FeatureKey,
  payload: CasePayload,
  classification: Classification,
  supersedesCaseId: string,
  correctionReason: string
): Promise<CorrectionResult> {
  const sql = db();
  // Read the prior case whatever its status. A correction that already
  // succeeded leaves it superseded, and filtering on `active` here would make
  // a replay of that completed write look like a failure before the
  // idempotency check below could recognize it.
  const rows = (await sql.query(
    "SELECT id, revision, source_issue_id, status FROM investigation_cases WHERE tenant_key = $1 AND id = $2",
    [TENANT_KEY, supersedesCaseId]
  )) as {
    id: string;
    revision: number;
    source_issue_id: string;
    status: CaseStatus;
  }[];
  const [prior] = rows;
  if (!prior) {
    return { created: false, reason: "prior_case_not_active" };
  }
  // A correction belongs to one ticket's chain. Superseding a case from
  // another ticket would leave that ticket with no active conclusion at all,
  // and would take this ticket's revision number from a history it is not
  // part of. The database cannot catch it: the two rows are independently
  // valid, and the one-active-case index only fires when the other ticket
  // already has a live case.
  if (prior.source_issue_id !== payload.sourceIssueId) {
    return { created: false, reason: "prior_case_other_ticket" };
  }

  const predecessorId = prior.id;
  const key = idempotencyKey(
    payload.sourceIssueId,
    classification,
    payload.rootCause,
    predecessorId
  );
  const replay = await caseIdFor(sql, key);
  if (replay !== null) {
    return { caseId: replay, created: false, reason: "already_recorded" };
  }

  // Corrections written before predecessor-aware keys were deployed used the
  // same key shape as a first revision. Match one only when it explicitly
  // supersedes this predecessor; otherwise A -> B -> A would mistake the
  // original A row for a replay of the later correction.
  const legacyReplay = await legacyCorrectionIdFor(
    sql,
    idempotencyKey(payload.sourceIssueId, classification, payload.rootCause),
    predecessorId
  );
  if (legacyReplay !== null) {
    return {
      caseId: legacyReplay,
      created: false,
      reason: "already_recorded",
    };
  }

  // Only now does the status matter: this is a genuinely new correction, so
  // the case it names has to still be the live one.
  if (prior.status !== "active") {
    return { created: false, reason: "prior_case_not_active" };
  }

  const id = randomUUID();
  const revision = prior.revision + 1;
  // Supersede first, then insert. The partial unique index allows one active
  // case per ticket and is checked per statement, so inserting the replacement
  // while the old row is still active fails. Both statements are in one
  // transaction, so a failed insert rolls the supersession back and the old
  // conclusion stays the active truth.
  //
  // ponytail: the prior revision is read before the transaction rather than
  // inside it, so two corrections racing on one ticket both compute the same
  // next revision. The unique (tenant, source issue, revision) constraint makes
  // the loser fail instead of writing a duplicate, which is the outcome an
  // interactive transaction would produce anyway.
  const [, inserted] = (await sql.transaction([
    sql.query(
      "UPDATE investigation_cases SET status = 'superseded', updated_at = now() WHERE tenant_key = $1 AND id = $2",
      [TENANT_KEY, prior.id]
    ),
    sql.query(
      INSERT_STRICT_SQL,
      insertParams(id, feature, payload, classification, {
        correctionReason,
        revision,
        supersedesCaseId: predecessorId,
      })
    ),
  ])) as [unknown, { id: string }[]];

  const [row] = inserted;
  if (!row) {
    throw new MemoryUnavailableError("The correction was not written.");
  }
  return {
    caseId: row.id,
    created: true,
    revision,
    supersededCaseId: predecessorId,
  };
}
