-- One finisher per widget run: the background watcher and the result poll both see
-- a finished investigation, and each was running the full extract, gate and compose.
ALTER TABLE widget_support_runs ADD COLUMN finishing_at timestamptz;
