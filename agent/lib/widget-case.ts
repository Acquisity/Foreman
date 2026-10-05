import { z } from "zod";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { scanIdentifiers } from "./widget-egress.js";
import type { WidgetContext } from "./widget-scope.js";

/**
 * One widget eval case: a real run's question and tool calls with every
 * customer identifier replaced, checked into `evals/widget/cases/`. The
 * expectations block is written empty for a person to fill.
 */
export const widgetCaseSchema = z.strictObject({
  cassette: z.array(
    z.strictObject({
      input: z.unknown(),
      output: z.unknown(),
      requestedAt: z.iso.datetime(),
      resultAt: z.iso.datetime(),
      status: z.string(),
      tool: z.string().min(1),
    })
  ),
  expectations: z.strictObject({
    cause: z.string().nullable(),
    claims: z.array(z.string()),
    fileTicket: z.boolean().nullable(),
    gateVerdict: z.enum(["allow", "rewrite", "block"]).nullable(),
    lane: z.enum(["chat", "human", "investigate", "kb"]).nullable(),
    toolBudget: z.int().positive().nullable(),
  }),
  question: z.string().min(1),
  scope: z.strictObject({
    role: z.enum(["owner", "admin", "member", "client"]),
    workspace: z.string().min(1),
  }),
  source: z.strictObject({
    runId: z.string().regex(/^wrun_[0-9A-Z]{26}$/),
    target: z.enum(["local", "preview", "production"]),
  }),
  tags: z.strictObject({
    lane: z.string().nullable(),
    role: z.string(),
    safety: z.array(z.string()),
    tools: z.array(z.string()),
  }),
});
export type WidgetCase = z.infer<typeof widgetCaseSchema>;

/** The real scope the run carried; every value here maps onto the fixture org. */
export type RunScope = Pick<
  WidgetContext,
  | "conversationId"
  | "organizationId"
  | "organizationName"
  | "organizationSlug"
  | "userId"
>;

export interface ScrubbedCase {
  case: WidgetCase;
  /** Every real value that was replaced, so the save can prove none is left. */
  originals: string[];
}

/** Keys whose string values name a person, company, campaign or workspace, or hold a phone number. */
const NAME_KEY = /(?:name|workspace|company)$/i;
const PHONE_KEY = /phone(?:_?number)?$/i;
/** A catalog entry's own id ("website_credit"): a name spelling one ("Website Credit") labels a product, not a customer. */
const CATALOG_ID = /^[a-z_]+$/;
/** An email is at most 320 characters; anything longer is not an identifier to map. */
const MAX_LITERAL = 320;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const DATA_URI = /^data:[^,]{1,200};base64,/;
/** An AI SDK content part or attachment that carries bytes rather than text. */
const BINARY_TYPE = /^(?:image|file|media)(?:-data|-url)?$/;
const BINARY_MEDIA = /^(?:image|audio|video)\//;
/** Fixed authored field references and help filenames also match the domain pattern. */
const AUTHORED_REFERENCES = new Set([
  "diagnostics.dailymetrics",
  "accounts.truncated",
  "accounts.available",
  "accounts.detailstruncated",
  "diagnostics.assignedinboxes.nextafterinboxid",
  "live.status",
  "live.deployment.builderror",
  "live.domains",
  "publiccheck.dns",
  "fields.event",
  "fields.organizationid",
  "campaigns.mdx",
  "where-is-the-bounce-protection-toggle-for-a-paused-campaign.mdx",
  "managing-campaigns.mdx",
  "campaign-states.mdx",
  "how-do-i-pause-a-campaign-without-stopping-my-subscription-payments.mdx",
  "what-do-the-account-statuses-mean.mdx",
  "email-accounts.mdx",
  "how-do-i-fix-an-account-with-an-error.mdx",
  "account-settings.mdx",
  "the-growth-plan-creator-shows-an-application-error.mdx",
]);
const LINEAR_REF = /^ENG-\d+$/;
const isInternalLink = (value: string) =>
  LINEAR_REF.test(value) || value.startsWith("http");
const OPS_ID = /^(?:[a-z]+_[a-z0-9]+|01[0-9a-z]{24})$/;
const PLACEHOLDER =
  /^(?:person-\d+@domain-\d+\.example|(?:domain-\d+|internal)\.example|00000000-0000-4000-8000-\d{12}|workspace-\d+)$/;
const FIXTURE_VALUES = new Set(
  Object.values(fixture).map((value) => value.toLowerCase())
);
const DROPPED = "[binary content dropped]";

const literal = (value: string) => value.replace(REGEX_SPECIAL, "\\$&");

/**
 * One bounded alternation of escaped literals, matched as whole words: a hyphen
 * ends a word, so an id joined to another ("<uuid>-<domain>-inboxes") is still
 * replaced, while a short value inside a longer word is not.
 */
const literalsPattern = (values: string[]) =>
  new RegExp(
    `(?<![A-Za-z0-9_])(?:${[...values]
      .sort((a, b) => b.length - a.length)
      .map(literal)
      .join("|")})(?![A-Za-z0-9_])`,
    "gi"
  );

const MAX_JSON_CHARS = 1_048_576;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const BYTE_KEY = /^(?:bytes|data|base64|imageBase64|buffer)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const JSON_START = /^\s*[[{]/;

const structuredText = (text: string): object | null => {
  if (!JSON_START.test(text)) {
    return null;
  }
  if (text.length > MAX_JSON_CHARS) {
    throw new Error("Structured tool text exceeds the JSON safety bound.");
  }
  try {
    const decoded: unknown = JSON.parse(text);
    return decoded && typeof decoded === "object" ? decoded : null;
  } catch {
    // Non-JSON prose is still inspected as text.
    return null;
  }
};

// Drop data URIs, typed media, and >=128-character base64 strings under explicit byte/data keys.
const isBinary = (value: unknown, key: string) => {
  if (typeof value === "string") {
    return (
      DATA_URI.test(value) ||
      (BYTE_KEY.test(key) && value.length >= 128 && BASE64.test(value))
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    BINARY_TYPE.test(String(record.type ?? "")) ||
    BINARY_MEDIA.test(String(record.mediaType ?? "")) ||
    BINARY_MEDIA.test(String(record.mimeType ?? ""))
  );
};

/** One bounded traversal of decoded values and keys, preserving JSON-string output types. */
const mapStrings = (
  value: unknown,
  visit: (text: string, key: string, isKey: boolean) => string,
  dropBinary = false
): unknown => {
  let nodes = 0;
  const walk = (item: unknown, key = "", depth = 0): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error("Case exceeds the traversal safety bound.");
    }
    if (dropBinary && isBinary(item, key)) {
      return DROPPED;
    }
    // A phone number stored as a number is still a phone number.
    if (typeof item === "number" && PHONE_KEY.test(key)) {
      return visit(String(item), key, false);
    }
    if (typeof item === "string") {
      const decoded = structuredText(item);
      return decoded
        ? JSON.stringify(walk(decoded, key, depth + 1))
        : visit(item, key, false);
    }
    if (Array.isArray(item)) {
      return item.map((child) => walk(child, key, depth + 1));
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([field, child]) => [
          visit(field, "", true),
          walk(child, field, depth + 1),
        ])
      );
    }
    return item;
  };
  return walk(value);
};

const isSafeIdentifier = (value: string) =>
  PLACEHOLDER.test(value) ||
  FIXTURE_VALUES.has(value) ||
  AUTHORED_REFERENCES.has(value);

/**
 * Replace every customer identifier the egress scan finds, the run's own scope,
 * and every name or phone field, with one placeholder per real value for the
 * whole case. Pure: nothing touches disk.
 */
export function scrubCase(raw: WidgetCase, scope: RunScope): ScrubbedCase {
  const found = {
    catalogIds: new Set<string>(),
    names: new Set<string>(),
    phones: new Set<string>(),
  };
  const draft = mapStrings(
    raw,
    (text, key) => {
      if (text) {
        if (key === "id" && CATALOG_ID.test(text)) {
          found.catalogIds.add(text);
        }
        if (PHONE_KEY.test(key)) {
          found.phones.add(text);
        } else if (NAME_KEY.test(key)) {
          found.names.add(text);
        }
      }
      return text;
    },
    true
  );
  const replacements = new Map<string, string>([
    [scope.organizationName.toLowerCase(), fixture.organizationName],
    [scope.organizationSlug.toLowerCase(), fixture.organizationSlug],
    [scope.organizationId.toLowerCase(), fixture.organizationId],
    [scope.userId.toLowerCase(), fixture.userId],
    [scope.conversationId.toLowerCase(), fixture.conversationId],
  ]);
  const counters = new Map<string, number>();
  const next = (kind: string) => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return n;
  };
  const add = (value: string, placeholder: () => string) => {
    const key = value.toLowerCase();
    if (!replacements.has(key)) {
      replacements.set(key, placeholder());
    }
  };
  const domain = (value: string) => {
    add(value, () => `domain-${next("domain")}.example`);
    return replacements.get(value.toLowerCase()) as string;
  };

  const { candidates, internal } = scanIdentifiers(JSON.stringify(draft));
  const localParts = new Map<string, string>();
  for (const email of candidates.emails) {
    const at = email.lastIndexOf("@");
    const host = domain(email.slice(at + 1));
    const localPart = email.slice(0, at);
    if (!localParts.has(localPart)) {
      localParts.set(localPart, `person-${next("person")}`);
    }
    add(email, () => `${localParts.get(localPart)}@${host}`);
  }
  for (const value of candidates.domains ?? []) {
    if (!isSafeIdentifier(value)) {
      domain(value);
    }
  }
  for (const uuid of candidates.uuids) {
    add(
      uuid,
      () => `00000000-0000-4000-8000-${String(next("uuid")).padStart(12, "0")}`
    );
  }
  for (const slug of candidates.slugs) {
    add(slug, () => `workspace-${next("workspace")}`);
  }
  for (const id of internal.filter((value) => OPS_ID.test(value))) {
    const prefix = id.includes("_") ? id.split("_")[0] : "ulid";
    add(id, () => `${prefix}_x${next("ops")}`);
  }
  // Internal ticket refs and internal links (a filed ticket's Linear URL) are not customer data,
  // but a ticket URL's slug repeats the customer's wording, so neither is kept.
  for (const value of internal.filter(isInternalLink)) {
    add(value, () =>
      LINEAR_REF.test(value)
        ? `ENG-${next("ticket")}`
        : `https://internal.example/${next("link")}`
    );
  }
  for (const name of found.names) {
    if (found.catalogIds.has(name.toLowerCase().replaceAll(" ", "_"))) {
      continue;
    }
    add(name, () => `Name ${next("name")}`);
  }
  for (const phone of found.phones) {
    add(phone, () => `Phone ${next("phone")}`);
  }

  const originals = Array.from(replacements)
    .filter(([real, placeholder]) => real !== placeholder.toLowerCase())
    .map(([real]) => real);
  // A value too long for the alternation (a long name field) is still replaced as a
  // whole field below; anywhere else it remains and findLeaks refuses the save.
  const inline = originals.filter((value) => value.length <= MAX_LITERAL);
  const pattern = inline.length ? literalsPattern(inline) : null;
  const scrubbed = pattern
    ? mapStrings(draft, (text, _key, isKey) =>
        isKey
          ? text
          : (replacements.get(text.toLowerCase()) ??
            text.replace(
              pattern,
              (match) => replacements.get(match.toLowerCase()) ?? match
            ))
      )
    : draft;
  return { case: widgetCaseSchema.parse(scrubbed), originals };
}

/** Everything identifier-shaped in a scrubbed case that is not a placeholder or a fixture value. */
export function findLeaks({ case: scrubbed, originals }: ScrubbedCase) {
  const text = JSON.stringify(scrubbed);
  const { candidates, internal } = scanIdentifiers(text);
  const leaks = [
    ...candidates.emails,
    ...candidates.uuids,
    ...candidates.slugs,
    ...(candidates.domains ?? []),
    ...internal.filter((value) => OPS_ID.test(value)),
  ].filter((value) => !isSafeIdentifier(value));
  if (originals.length) {
    mapStrings(scrubbed, (value) => {
      const lower = value.toLowerCase();
      leaks.push(
        ...originals.filter((original) => {
          // A fixture value is not a leak of an original it contains ("<name>'s Workspace").
          let rest = lower;
          for (const fixed of FIXTURE_VALUES) {
            if (fixed.includes(original)) {
              rest = rest.replaceAll(fixed, "\0");
            }
          }
          return rest.includes(original);
        })
      );
      return value;
    });
  }
  return leaks;
}

/** The only way a case reaches disk: the file text, or a throw when anything is left. */
export function serializeCase(scrubbed: ScrubbedCase): string {
  widgetCaseSchema.parse(scrubbed.case);
  const leaks = findLeaks(scrubbed);
  if (leaks.length) {
    throw new Error(
      `Case not saved: ${leaks.length} unreplaced identifier(s) remain.`
    );
  }
  return `${JSON.stringify(scrubbed.case, null, 2)}\n`;
}
