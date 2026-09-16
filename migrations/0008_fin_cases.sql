-- Operational case associations, separate from investigation memory and run expiry.
CREATE TABLE fin_cases (
  id uuid PRIMARY KEY REFERENCES fin_investigation_runs(id),
  scope jsonb NOT NULL,
  decision jsonb NOT NULL,
  issue_id text,
  created_here boolean NOT NULL DEFAULT false,
  creation_attempted boolean NOT NULL DEFAULT false,
  document_attempted boolean NOT NULL DEFAULT false,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_cases_owner ON fin_cases ((scope->>'userId'), (scope->>'organizationId'));
