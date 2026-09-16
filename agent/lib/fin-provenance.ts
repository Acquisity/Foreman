import { identifierPatterns } from "./fin-identifiers.js";
import type { FinContext } from "./fin-scope.js";

const SESSIONS = 64;
const VALUES = 2000;
const TEXT_MAX = 512 * 1024;

/** The shared identifier shapes, reused from the customer-reply egress gate. */
const SHARED = new RegExp(
  identifierPatterns.map(([, pattern]) => pattern.source).join("|"),
  "gi"
);
/**
 * The shapes a customer reply never carries, so the egress gate has no reason
 * to know them: an opaque provider token (a Stripe `cus_...`, an Autumn or
 * Sentry id) and a ULID run id. The uppercase letter is what tells one apart
 * from an ordinary snake_case column or table name inside a query body.
 */
const PROVIDER_TOKEN =
  /\b[a-z][a-z0-9]{1,12}_(?=[A-Za-z0-9]{8})[A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** Per session, in memory, never persisted: the scope's own values and what calls returned. */
const learned = new Map<string, Set<string>>();

const known = (sessionId: string, scope: FinContext) => {
  const existing = learned.get(sessionId);
  if (existing) {
    return existing;
  }
  if (learned.size >= SESSIONS) {
    learned.delete(learned.keys().next().value as string);
  }
  const fresh = new Set(
    [
      scope.organizationId,
      scope.userId,
      scope.contactId,
      scope.conversationId,
      scope.intercomAppId,
      scope.organizationSlug,
    ].map((value) => value.toLowerCase())
  );
  learned.set(sessionId, fresh);
  return fresh;
};

/** Every identifier in the serialized value, so one embedded in a query body counts. */
const scan = (value: unknown): string[] | null => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return null;
  }
  if (text.length > TEXT_MAX) {
    return null;
  }
  return [SHARED, PROVIDER_TOKEN].flatMap((scanner) =>
    [...text.matchAll(scanner)].map((match) => match[0].toLowerCase())
  );
};

/** True when the input names a record this session has no provenance for. */
export const finUnknownIdentifier = (
  sessionId: string,
  scope: FinContext,
  input: unknown
): boolean => {
  const found = scan(input);
  const allowed = known(sessionId, scope);
  return found === null || found.some((value) => !allowed.has(value));
};

/** What a successful call returned becomes reachable by name for the rest of the session. */
export const finLearnIdentifiers = (
  sessionId: string,
  scope: FinContext,
  data: unknown
): void => {
  const allowed = known(sessionId, scope);
  for (const value of scan(data) ?? []) {
    if (allowed.size >= VALUES) {
      return;
    }
    allowed.add(value);
  }
};
