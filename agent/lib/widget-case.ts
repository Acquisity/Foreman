import { z } from "zod";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import { PUBLIC_HOSTS, scanIdentifiers } from "./widget-egress.js";
import { renderConversation } from "./widget-router.js";
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
    /** What the recorded evidence shows the cause to be; investigate cases carry it (ENG-15024). */
    causeType: z
      .enum(["user_error", "platform_limitation", "bug", "unclear"])
      .optional(),
    claims: z.array(z.string()),
    fileTicket: z.boolean().nullable(),
    foreignIdentifiers: z
      .array(z.string().min(1).max(320))
      .max(200)
      .default([]),
    gateVerdict: z.enum(["allow", "rewrite", "block"]).nullable(),
    lane: z.enum(["chat", "human", "investigate", "kb"]).nullable(),
    toolBudget: z.int().positive().nullable(),
  }),
  /**
   * Sent with the question, as the app sends an owner or admin's "Investigate
   * my workspace" toggle. Without it a message never starts an investigation.
   */
  mode: z.literal("investigate").optional(),
  question: z.string().min(1),
  scope: z.strictObject({
    role: z.enum(["owner", "admin", "member", "client"]),
    workspace: z.string().min(1),
  }),
  source: z.strictObject({
    // Null for a front-door case: hand-written ones have no source run, and a recorded front-door run id is a UUID the scrubber replaces. Replay still starts a run.
    runId: z
      .string()
      .regex(/^wrun_[0-9A-Z]{26}$/)
      .nullable(),
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
/**
 * Provider record ids the egress scan does not know (billing: cus_prod_..., cus_ent_...,
 * py_..., pr_..., fe_..., ent_...): a short lowercase prefix, then an opaque tail of 10+
 * characters with a digit or capital, so snake_case words never match. Input is bounded
 * by the traversal; the pattern has no nested quantifiers. A case's own source run id
 * (wrun_...) is deliberate provenance and stays.
 */
const PROVIDER_ID =
  /(?<![A-Za-z0-9_])(?!wrun_)[a-z]{2,5}(?:_[a-z]{2,6})?_(?=[A-Za-z0-9]{0,63}[0-9A-Z])[A-Za-z0-9]{10,64}(?![A-Za-z0-9_])/g;
const PLACEHOLDER =
  /^(?:person-\d+@domain-\d+\.example|(?:domain-\d+|internal)\.example|00000000-0000-4000-8000-\d{12}|workspace-\d+)$/;
const FIXTURE_VALUES = new Set(
  Object.values(fixture).map((value) => value.toLowerCase())
);
const DROPPED = "[binary content dropped]";

const literal = (value: string) => value.replace(REGEX_SPECIAL, "\\$&");

/**
 * Names of billing catalog entries ({ id: "website_credit", name: "Website Credit" })
 * in widget_billing_summary results, counted per spelling. Only these objects are
 * product labels; the same spelling anywhere else is still a name to replace.
 */
const billingCatalogNames = (raw: WidgetCase) => {
  const counts = new Map<string, number>();
  const walk = (item: unknown, depth: number): void => {
    if (typeof item === "string") {
      const decoded = structuredText(item);
      if (decoded) {
        walk(decoded, depth + 1);
      }
      return;
    }
    if (depth > MAX_DEPTH || !item || typeof item !== "object") {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        walk(child, depth + 1);
      }
      return;
    }
    const { id, name } = item as Record<string, unknown>;
    if (
      typeof id === "string" &&
      typeof name === "string" &&
      CATALOG_ID.test(id) &&
      name.toLowerCase().replaceAll(" ", "_") === id
    ) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const child of Object.values(item)) {
      walk(child, depth + 1);
    }
  };
  for (const call of raw.cassette) {
    if (call.tool === "widget_billing_summary") {
      walk(call.output, 0);
    }
  }
  return counts;
};

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

const OWN_DOMAIN_PERSON = /^person-\d+@(.+)$/;

/** A screen recording is titled "<recorder's name> · <workspace name>", often inside a JSON-encoded string. */
const recorderNames = (draft: unknown, organizationName: string) =>
  Array.from(
    JSON.stringify(draft).matchAll(
      new RegExp(
        `(?<=")([^"\\\\·]{1,80}) · ${literal(organizationName)}(?=\\\\?")`,
        "gi"
      )
    ),
    ([, recorder]) => recorder
  );

const countInto = (counts: Map<string, number>, values: string[]) => {
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
};

/** Our own domain stays: replacing it would also rewrite every help-center link. */
const ownDomain = (host: string, replace: (host: string) => string) =>
  PUBLIC_HOSTS.has(host.toLowerCase()) ? host : replace(host);

const isSafeIdentifier = (value: string) =>
  PLACEHOLDER.test(value) ||
  PUBLIC_HOSTS.has(value.match(OWN_DOMAIN_PERSON)?.[1] ?? "") ||
  FIXTURE_VALUES.has(value) ||
  AUTHORED_REFERENCES.has(value);

/**
 * Replace every customer identifier the egress scan finds, the run's own scope,
 * and every name or phone field, with one placeholder per real value for the
 * whole case. Pure: nothing touches disk.
 */
export function scrubCase(raw: WidgetCase, scope: RunScope): ScrubbedCase {
  const found = {
    names: new Map<string, number>(),
    phones: new Set<string>(),
  };
  const draft = mapStrings(
    raw,
    (text, key) => {
      if (text) {
        if (PHONE_KEY.test(key)) {
          found.phones.add(text);
        } else if (NAME_KEY.test(key)) {
          found.names.set(text, (found.names.get(text) ?? 0) + 1);
        }
      }
      return text;
    },
    true
  );
  // After the first pass, so dropped media is never serialized.
  countInto(found.names, recorderNames(draft, scope.organizationName));
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
    const host = ownDomain(email.slice(at + 1), domain);
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
  const opaqueIds = new Set([
    ...(JSON.stringify(draft).match(PROVIDER_ID) ?? []),
    ...internal.filter((value) => OPS_ID.test(value)),
  ]);
  for (const id of opaqueIds) {
    const prefix = id.includes("_") ? id.slice(0, id.lastIndexOf("_")) : "ulid";
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
  const catalogNames = billingCatalogNames(raw);
  for (const [name, count] of found.names) {
    // Kept only when every occurrence is a billing catalog label.
    if (catalogNames.get(name) === count) {
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
    ...(text.match(PROVIDER_ID) ?? []),
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
              rest = rest.replace(
                new RegExp(`(?<![a-z0-9_])${literal(fixed)}(?![a-z0-9_])`, "g"),
                "\0"
              );
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

const LATEST = "LATEST CUSTOMER MESSAGE (the one to work on):\n";
const EARLIER = "\n\nEARLIER TURNS (";
const TURN = /^(Customer|Support): /u;
/** The app sends at most the last 8 customer-visible messages, 2,000 characters each. */
const APP_HISTORY_MESSAGES = 8;
const APP_HISTORY_CHARS = 2000;

/** One recorded front-door turn: the customer's message and the reply that went out, if any. */
export interface RecordedTurn {
  question: string;
  reply: string | null;
}

/**
 * A front-door run's question in the router's own rendering: the last turn's
 * message, then the earlier turns as the app sent them. Replay splits it back
 * into the message and its history with `toRequest`.
 */
export function frontDoorQuestion(turns: RecordedTurn[]): string {
  const latest = turns.at(-1);
  if (!latest) {
    throw new Error("A front-door case needs at least one turn.");
  }
  const history = turns
    .slice(0, -1)
    .flatMap(({ question, reply }) => [
      { role: "customer" as const, text: question },
      ...(reply ? [{ role: "assistant" as const, text: reply }] : []),
    ])
    .slice(-APP_HISTORY_MESSAGES)
    .map((turn) => ({ ...turn, text: turn.text.slice(0, APP_HISTORY_CHARS) }));
  return renderConversation(latest.question, history);
}

/** A recorded question is the router's rendering; split it back into the message and its earlier turns. */
export function toRequest(question: string): {
  history?: { role: "assistant" | "customer"; text: string }[];
  question: string;
} {
  if (!question.startsWith(LATEST)) {
    return { question };
  }
  const cut = question.indexOf(EARLIER);
  const latest = question.slice(LATEST.length, cut < 0 ? undefined : cut);
  const history: { role: "assistant" | "customer"; text: string }[] = [];
  const lines =
    cut < 0
      ? []
      : question.slice(question.indexOf("\n", cut + 2) + 1).split("\n");
  for (const line of lines) {
    const role = TURN.exec(line)?.[1];
    if (role) {
      history.push({
        role: role === "Customer" ? "customer" : "assistant",
        text: line.slice(role.length + 2),
      });
    } else {
      const last = history.at(-1);
      if (last) {
        last.text += `\n${line}`;
      }
    }
  }
  return { history, question: latest };
}
