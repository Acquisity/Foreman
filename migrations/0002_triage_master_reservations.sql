-- A single fail-closed causal head prevents concurrent same-cause intake from
-- creating two Linear masters. A 30-day generation can advance only from the
-- exact completed stale predecessor. Unresolved reservations never expire into
-- permission for another create; a person must reconcile them against Linear.

CREATE TABLE IF NOT EXISTS triage_master_reservations (
  id uuid PRIMARY KEY,
  tenant_key text NOT NULL,
  causal_fingerprint text NOT NULL,
  generation_key text NOT NULL,
  master_recency_policy text NOT NULL,
  eligibility_evaluated_at timestamptz NOT NULL,
  source_issue_id text NOT NULL,
  critic_approval_id text NOT NULL,
  evidence_revision text NOT NULL,
  reviewer_model text NOT NULL,
  review_attempt integer NOT NULL,
  master_issue_id text,
  master_created_at timestamptz,
  status text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT triage_master_reservations_status_check
    CHECK (status IN ('reserved', 'complete')),
  CONSTRAINT triage_master_reservations_review_attempt_check
    CHECK (review_attempt IN (1, 2)),
  CONSTRAINT triage_master_reservations_approval_check
    CHECK (critic_approval_id ~ '^trv_[a-f0-9]{64}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT triage_master_reservations_policy_check
    CHECK (master_recency_policy IN ('UNBOUNDED', 'THIRTY_DAY')),
  CONSTRAINT triage_master_reservations_causal_head_unique
    UNIQUE (tenant_key, causal_fingerprint)
);

CREATE INDEX IF NOT EXISTS triage_master_reservations_status
  ON triage_master_reservations (tenant_key, status);
