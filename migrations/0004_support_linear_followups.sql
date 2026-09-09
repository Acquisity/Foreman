-- Linked engineering progress belongs to the existing support case and outbox.
ALTER TABLE support_handoffs
  ADD COLUMN linear_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN linear_observed jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN linear_processed jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN report_revision text;
