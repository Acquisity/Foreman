-- Operational run ownership, separate from investigation memory and support queues.
CREATE TABLE fin_investigation_runs (
  id uuid PRIMARY KEY,
  app_id text NOT NULL,
  conversation_id text NOT NULL,
  request_key text NOT NULL,
  scope jsonb NOT NULL,
  session_id text,
  callback_url text NOT NULL,
  callback_attempts integer NOT NULL DEFAULT 0,
  callback_delivered boolean NOT NULL DEFAULT false,
  slack jsonb,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (app_id, conversation_id, request_key)
);
CREATE UNIQUE INDEX fin_one_active_conversation ON fin_investigation_runs (app_id, conversation_id) WHERE completed_at IS NULL;
