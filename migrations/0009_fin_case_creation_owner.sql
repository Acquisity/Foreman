-- Late calls from older runs cannot race a new run into duplicate creation.
CREATE UNIQUE INDEX fin_one_unresolved_case_creation
  ON fin_cases ((scope->>'intercomAppId'), (scope->>'conversationId'))
  WHERE creation_attempted = true AND outcome IS NULL;
