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
const PHONE_KEY = /phone(?:number)?$/i;
/** Shorter names are too generic to replace inside prose; longer values are prose, not names. */
const NAME_LENGTH = { max: 200, min: 3 };
/** An email is at most 320 characters; anything longer is not an identifier to map. */
const MAX_LITERAL = 320;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const DATA_URI = /^data:[^;,]{1,100};base64,/;
/** An AI SDK content part or attachment that carries bytes rather than text. */
const BINARY_TYPE = /^(?:image|file|media)(?:-data|-url)?$/;
const BINARY_MEDIA = /^(?:image|audio|video)\//;
/** Help-center paths name `.mdx` files, which the domain pattern also matches. */
const DOC_FILE = /\.mdx$/;
const OPS_ID = /^(?:[a-z]+_[a-z0-9]+|01[0-9a-z]{24})$/;
const PLACEHOLDER =
  /^(?:person-\d+@domain-\d+\.example|domain-\d+\.example|00000000-0000-4000-8000-\d{12}|workspace-\d+)$/;
const FIXTURE_VALUES = new Set(
  Object.values(fixture).map((value) => value.toLowerCase())
);
const DROPPED = "[binary content dropped]";

const literal = (value: string) => value.replace(REGEX_SPECIAL, "\\$&");

/** One bounded alternation of escaped literals, matched only as whole tokens. */
const literalsPattern = (values: string[]) =>
  new RegExp(
    `(?<![A-Za-z0-9_-])(?:${[...values]
      .sort((a, b) => b.length - a.length)
      .map(literal)
      .join("|")})(?![A-Za-z0-9_-])`,
    "gi"
  );

const mapStrings = (value: unknown, map: (text: string) => string): unknown => {
  if (typeof value === "string") {
    return map(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, map));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])
    );
  }
  return value;
};

/** Images, files and base64 payloads are dropped whole; they are never scanned. */
const dropBinary = (value: unknown): unknown => {
  if (typeof value === "string") {
    return DATA_URI.test(value) ? DROPPED : value;
  }
  if (Array.isArray(value)) {
    return value.map(dropBinary);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      BINARY_TYPE.test(String(record.type ?? "")) ||
      BINARY_MEDIA.test(String(record.mediaType ?? ""))
    ) {
      return DROPPED;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, dropBinary(item)])
    );
  }
  return value;
};

/** Every object key and every string under a name or phone key. */
const walk = (
  value: unknown,
  keys: Set<string>,
  found: { names: Set<string>; phones: Set<string> }
) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, keys, found);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.add(key.toLowerCase());
    if (typeof item === "string") {
      if (PHONE_KEY.test(key)) {
        found.phones.add(item);
      } else if (
        NAME_KEY.test(key) &&
        item.length >= NAME_LENGTH.min &&
        item.length <= NAME_LENGTH.max
      ) {
        found.names.add(item);
      }
    }
    walk(item, keys, found);
  }
};

const objectKeys = (value: unknown) => {
  const keys = new Set<string>();
  walk(value, keys, { names: new Set(), phones: new Set() });
  return keys;
};

/** A dotted field reference such as `diagnostics.dailyMetrics` matches the domain pattern too. */
const isFieldPath = (domain: string, keys: Set<string>) =>
  domain.split(".").every((label) => keys.has(label));

const isSafeIdentifier = (value: string, keys: Set<string>) =>
  PLACEHOLDER.test(value) ||
  FIXTURE_VALUES.has(value) ||
  DOC_FILE.test(value) ||
  isFieldPath(value, keys);

/**
 * Replace every customer identifier the egress scan finds, the run's own scope,
 * and every name or phone field, with one placeholder per real value for the
 * whole case. Pure: nothing touches disk.
 */
export function scrubCase(raw: WidgetCase, scope: RunScope): ScrubbedCase {
  const draft = dropBinary(raw) as WidgetCase;
  const keys = new Set<string>();
  const found = { names: new Set<string>(), phones: new Set<string>() };
  walk(
    draft.cassette.map((call) => [call.input, call.output]),
    keys,
    found
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
  for (const email of candidates.emails) {
    const at = email.lastIndexOf("@");
    const host = domain(email.slice(at + 1));
    add(email, () => `person-${next("person")}@${host}`);
  }
  for (const value of candidates.domains ?? []) {
    if (!(DOC_FILE.test(value) || isFieldPath(value, keys))) {
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
  for (const name of found.names) {
    add(name, () => `Name ${next("name")}`);
  }
  for (const phone of found.phones) {
    add(phone, () => `Phone ${next("phone")}`);
  }

  const originals = Array.from(replacements)
    .filter(([real, placeholder]) => real !== placeholder.toLowerCase())
    .map(([real]) => real);
  if (originals.some((value) => value.length > MAX_LITERAL)) {
    throw new Error("A value to replace is too long to be an identifier.");
  }
  const pattern = originals.length ? literalsPattern(originals) : null;
  const scrubbed = pattern
    ? mapStrings(draft, (text) =>
        text.replace(
          pattern,
          (match) => replacements.get(match.toLowerCase()) ?? match
        )
      )
    : draft;
  return { case: widgetCaseSchema.parse(scrubbed), originals };
}

/** Everything identifier-shaped in a scrubbed case that is not a placeholder or a fixture value. */
export function findLeaks({ case: scrubbed, originals }: ScrubbedCase) {
  const text = JSON.stringify(scrubbed);
  const keys = objectKeys(scrubbed);
  const { candidates, internal } = scanIdentifiers(text);
  const leaks = [
    ...candidates.emails,
    ...candidates.uuids,
    ...candidates.slugs,
    ...(candidates.domains ?? []),
    ...internal.filter((value) => OPS_ID.test(value)),
  ].filter((value) => !isSafeIdentifier(value, keys));
  if (originals.length) {
    leaks.push(...(text.match(literalsPattern(originals)) ?? []));
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
