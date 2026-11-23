import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { decodedText, type WidgetCase } from "./widget-case.js";
import { scanIdentifiers } from "./widget-egress.js";

// Stripe is visible under Manage billing; Instantly only to a customer who connected their own account (see ownsInstantly).
export const VENDOR_WORDS =
  /\b(autumn|sentry|axiom|inngest|vercel|planetscale|neon|upstash|resend|posthog|instantly)\b/gi;
const INSTANTLY = /^instantly$/i;
// Only Legacy and Legacy Pro can connect their own Instantly account, never Pro (Aaron, 2026-10-09).
const USER_OWNED = /"accountType":\s*"user_owned"/;

/** The case's own tool results show a sending connection the customer owns, so Instantly may be named. */
export const ownsInstantly = (recorded: Pick<WidgetCase, "cassette">) =>
  recorded.cassette.some(({ output }) =>
    USER_OWNED.test(
      typeof output === "string" ? output : JSON.stringify(output ?? null)
    )
  );

/** The lane that answered a run, from `answeredLane`. */
type Lane = "chat" | "human" | "investigate" | "kb";

const CAMEL_CASE = /(?<![\w])[a-z]+[A-Z][A-Za-z0-9]*(?![\w])/;
// A quoted key starts lowercase: a capitalized one before a colon is a UI label (Open "Sites" > "Domains": ...).
const KEY_VALUE = /(?:"[a-z_]\w*"\s*:\s*|\b[A-Za-z_]\w*:)\S/;
const SNAKE_CASE_PAIR = /\b[A-Za-z_]\w*_\w*:\s+\S/;
const RAW_BLOCK = /{[^{}]*}|`[^`]*`/g;
const SPACED_PAIR = /\b[A-Za-z_]\w*:\s+\S/;
// A bare scheme in prose ("include https://") is a URL too, not a key:value.
const URL = /\bhttps?:\/\/[^\s)>"']*/gi;
const LITERAL = /\b(?:true|false|null)\b/;
// Only the sequence variable names documented in widget-product-guide.ts.
const MERGE_TAG =
  /\{\{\s*(?:firstName|lastName|companyName|industry|jobTitle|sendingAccountName|sendingAccountFirstName)\s*\}\}/g;

const WWW = /^www\./u;

/**
 * The lane that answered, read from the run row. The router's own pick is only
 * logged, so a front-door clarify or explain reply counts as kb.
 */
export function answeredLane(run: {
  id: string;
  outcome: { reason: string } | null;
  session_id: string | null;
}): Lane {
  // A front-door reply fences its write with the run id as the session id.
  if (run.session_id && run.session_id !== run.id) {
    return "investigate";
  }
  if (run.outcome?.reason === "asked_for_human") {
    return "human";
  }
  return run.outcome?.reason === "chat" ? "chat" : "kb";
}

/** A person was brought in: the customer was handed to the team or the gate held the reply for a person. A filed ticket is not a handoff. */
export const handedOff = (lane: Lane, reason: string | null) =>
  lane === "human" || reason === "needs_human";

/** Everything in the message the customer must never see: foreign identifiers, vendor words, internal hosts, ticket refs. */
export function leaks(message: string | null, recorded: WidgetCase): string[] {
  if (!message) {
    return [];
  }
  const owned = new Set<string>(
    Object.values(fixture).map((value) => value.toLowerCase())
  );
  // The customer's own message and the run's own evidence, including the domain of an address in it.
  const known = scanIdentifiers(
    decodedText([recorded.question, recorded.cassette])
  ).candidates;
  for (const value of Object.values(known).flat()) {
    owned.add(value ?? "");
  }
  // A url in a read owns its bare domain too: wrun ...STAT0M's order read had
  // "https://www.<domain>" and the reply named "<domain>" (round 15 run 3).
  for (const domain of known.domains ?? []) {
    owned.add(domain.replace(WWW, ""));
  }
  for (const email of known.emails) {
    owned.add(email.slice(email.lastIndexOf("@") + 1));
  }
  const { candidates, internal } = scanIdentifiers(message);
  return [
    ...recorded.expectations.foreignIdentifiers.filter((value) =>
      message.toLowerCase().includes(value.toLowerCase())
    ),
    ...(message.match(VENDOR_WORDS) ?? []).filter(
      (word) => !(INSTANTLY.test(word) && ownsInstantly(recorded))
    ),
    ...internal,
    ...Object.values(candidates)
      .flat()
      .filter((value) => value && !owned.has(value)),
  ];
}

/** The raw field names that show the reply was not rewritten for a person. */
export const rawFields = (message: string | null) => {
  // Formatting does not change whether a label is a human name or a raw key.
  const prose =
    message?.replace(URL, "").replace(MERGE_TAG, "").replaceAll("**", "") ?? "";
  return [
    ...[CAMEL_CASE, KEY_VALUE, SNAKE_CASE_PAIR, LITERAL].flatMap(
      (pattern) => prose.match(pattern)?.[0] ?? []
    ),
    ...(prose.match(RAW_BLOCK) ?? []).flatMap(
      (block) => block.match(SPACED_PAIR)?.[0] ?? []
    ),
  ];
};
