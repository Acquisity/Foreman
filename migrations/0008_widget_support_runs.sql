-- In-app support widget runs: one active investigation per conversation, gate decision persisted.
CREATE TABLE widget_support_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  request_key text NOT NULL,
  question text NOT NULL,
  scope jsonb NOT NULL,
  session_id text,
  stream_index integer NOT NULL DEFAULT 0,
  findings jsonb,
  decision text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, conversation_id, request_key)
);
CREATE UNIQUE INDEX widget_one_active_conversation ON widget_support_runs (organization_id, conversation_id) WHERE completed_at IS NULL;
CREATE INDEX widget_support_runs_conversation ON widget_support_runs (organization_id, conversation_id, created_at DESC);
