/**
 * Identifier shapes that must never reach a customer reply.
 *
 * A customer needs the cause in plain language, never a record identifier, so
 * this gate deliberately knows nothing about whose identifier a value is. That
 * is what keeps it correct as connections are added: there is no provenance to
 * look up and no allowlist to go stale.
 *
 * Every pattern is a fixed literal with no interpolated data, and the scanned
 * text is the answer `boundedFinAnswer` already truncated, so matching stays
 * bounded. The numeric bound is eight consecutive digits: an ordinary count,
 * percentage, price or year in a customer reply stays well under ten million,
 * while the record identifiers worth withholding (conversation ids, unix
 * timestamps, database ids) are longer than that. Order matters only for the
 * reported category, because a uuid and an email also carry digit runs.
 */
export const identifierPatterns = [
  ["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  [
    "email",
    /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/,
  ],
  ["ticket", /ENG-\d+/i],
  ["numeric", /\d{8,}/],
] as const;
