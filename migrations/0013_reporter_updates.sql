CREATE TABLE reporter_updates (
  issue text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('received', 'owner', 'fixed', 'not_fixed')),
  status text NOT NULL CHECK (status IN ('waiting', 'claimed', 'sent')),
  slack_channel text,
  message text,
  comment_id text,
  checked_sha text,
  claim_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue, stage)
);
CREATE INDEX reporter_updates_waiting ON reporter_updates (updated_at) WHERE status = 'waiting';
CREATE TABLE reporter_pending (
  issue text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  last_try timestamptz,
  retry_after timestamptz
);
CREATE TABLE reporter_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  since timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
