-- Investigation memory: one immutable row per completed triage investigation,
-- with corrections stored as new revisions that supersede the old one.
--
-- Statements are separated by a semicolon at end of line. The migration runner
-- splits on that, so keep semicolons out of string literals in this file.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investigation_cases (
  id uuid PRIMARY KEY,
  tenant_key text NOT NULL,
  primary_feature_key text NOT NULL,
  affected_feature_keys text[] NOT NULL DEFAULT '{}',
  dependency_keys text[] NOT NULL DEFAULT '{}',
  linear_project_id uuid NOT NULL,
  component text,
  provider text,
  source_issue_id text NOT NULL,
  source_issue_url text NOT NULL,
  source_document_url text,
  revision integer NOT NULL DEFAULT 1,
  classification text NOT NULL,
  claim text NOT NULL,
  symptoms text[] NOT NULL DEFAULT '{}',
  error_signatures text[] NOT NULL DEFAULT '{}',
  code_paths text[] NOT NULL DEFAULT '{}',
  commit_sha text,
  root_cause text NOT NULL,
  resolution text,
  ruled_out text[] NOT NULL DEFAULT '{}',
  evidence_refs text[] NOT NULL DEFAULT '{}',
  affected_org_count integer,
  affected_user_count integer,
  counted_at date,
  confidence text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  supersedes_case_id uuid REFERENCES investigation_cases (id),
  correction_reason text,
  observed_from timestamptz,
  observed_to timestamptz,
  idempotency_key text NOT NULL,
  search_document tsvector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investigation_cases_classification_check
    CHECK (classification IN ('user_error', 'platform_limitation', 'bug', 'unproven')),
  CONSTRAINT investigation_cases_confidence_check
    CHECK (confidence IN ('low', 'medium', 'high')),
  CONSTRAINT investigation_cases_status_check
    CHECK (status IN ('active', 'superseded', 'corrected', 'obsolete')),
  CONSTRAINT investigation_cases_counted_at_check
    CHECK (counted_at IS NOT NULL OR (affected_org_count IS NULL AND affected_user_count IS NULL)),
  CONSTRAINT investigation_cases_revision_unique
    UNIQUE (tenant_key, source_issue_id, revision)
);

-- Replaying a completed write must not create a second case.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_cases_idempotency
  ON investigation_cases (tenant_key, idempotency_key);

-- At most one current truth per source ticket. A correction flips the old row
-- to superseded in the same transaction that inserts the new one.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_cases_one_active
  ON investigation_cases (tenant_key, source_issue_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS investigation_cases_scope
  ON investigation_cases (tenant_key, primary_feature_key, status, created_at DESC);

CREATE INDEX IF NOT EXISTS investigation_cases_affected
  ON investigation_cases USING gin (affected_feature_keys);

CREATE INDEX IF NOT EXISTS investigation_cases_dependencies
  ON investigation_cases USING gin (dependency_keys);

CREATE INDEX IF NOT EXISTS investigation_cases_search
  ON investigation_cases USING gin (search_document);
