-- Investigation memory learns from ticketless Intercom and Slack investigations
-- and from conclusions a human corrected in a thread (ENG-13175).
--
-- Additive only. The source id column already keys every constraint, so the
-- new `intercom:<id>` and `slack:<channel>/<ts>` sources get the same
-- idempotency, one-active-case, and revision guarantees as a Linear ticket.
-- Statements are separated by a semicolon at end of line, so keep semicolons
-- out of string literals in this file.

-- A ticketless source has no Linear project. The product area still comes
-- from primary_feature_key, which stays NOT NULL.
ALTER TABLE investigation_cases ALTER COLUMN linear_project_id DROP NOT NULL;

-- The resolution and the ruled-out conclusions are now part of the searched
-- text, because the fix path is what a corrected case is worth recalling for.
-- Rows written before this change are rebuilt the same way new rows are.
UPDATE investigation_cases
  SET search_document = to_tsvector('english', concat_ws(' ',
    claim, root_cause, resolution, component, provider,
    array_to_string(symptoms, ' '),
    array_to_string(error_signatures, ' '),
    array_to_string(code_paths, ' '),
    array_to_string(ruled_out, ' ')));
