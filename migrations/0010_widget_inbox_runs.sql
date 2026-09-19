-- A teammate's inbox investigation and the customer's own run are separate lanes:
-- one open run per conversation per source, so neither blocks or is handed the other's result.
DROP INDEX IF EXISTS widget_one_active_conversation;
CREATE UNIQUE INDEX widget_one_active_conversation ON widget_support_runs (organization_id, conversation_id, (scope->>'source')) WHERE completed_at IS NULL;
