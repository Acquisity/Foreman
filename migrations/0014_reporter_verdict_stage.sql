-- Reporters hear what Fixy's finished bug run found on their open ticket
-- (ENG-16061), recorded as the `verdict` stage. 0013 left its stage CHECK
-- unnamed, so Postgres named it reporter_updates_stage_check; it is replaced
-- by the same check with `verdict` added. Until this runs, a verdict claim
-- fails on the old check and nothing is posted.
ALTER TABLE reporter_updates DROP CONSTRAINT reporter_updates_stage_check;
ALTER TABLE reporter_updates ADD CONSTRAINT reporter_updates_stage_check
  CHECK (stage IN ('received', 'owner', 'fixed', 'not_fixed', 'verdict'));
