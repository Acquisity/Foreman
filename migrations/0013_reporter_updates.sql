-- One row per reporter ticket and message stage. The primary key is the once-only guard.
CREATE TABLE reporter_updates (
  issue text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('received', 'owner', 'fixed', 'not_fixed')),
  status text NOT NULL CHECK (status IN ('waiting', 'claimed', 'sent')),
  slack_channel text,
  message text,
  comment_id text,
  checked_sha text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue, stage)
);
CREATE INDEX reporter_updates_waiting ON reporter_updates (updated_at) WHERE status = 'waiting';
