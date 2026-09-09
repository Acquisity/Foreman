-- Operational state for the Intercom trial, separate from investigation memory.
CREATE TABLE support_handoffs (
  conversation text NOT NULL,
  thread text NOT NULL,
  lease uuid,
  lease_until timestamptz,
  next_check timestamptz NOT NULL DEFAULT now(),
  closed boolean NOT NULL DEFAULT false,
  version text,
  processed_version text,
  last_report_hash text,
  report text,
  report_hash text,
  report_kind text CHECK (report_kind IN ('final', 'retry', 'failure')),
  report_key uuid,
  posted_ts text,
  delivery_attempted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation, thread)
);
CREATE INDEX support_handoffs_due ON support_handoffs(next_check) WHERE NOT closed;
CREATE TABLE support_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  oldest text NOT NULL
);
CREATE TABLE support_operations (
  conversation text NOT NULL,
  thread text NOT NULL,
  operation_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'done', 'failed')),
  result jsonb,
  PRIMARY KEY (conversation, thread, operation_key),
  FOREIGN KEY (conversation, thread) REFERENCES support_handoffs(conversation, thread)
);
