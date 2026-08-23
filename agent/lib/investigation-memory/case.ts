import { z } from "zod";
import { FEATURE_KEYS, isDependencyKey, MAX_SCOPE_ENTRIES } from "./scope.js";

/**
 * The case payload a completed triage investigation writes, and the guards
 * that keep customer identity and credentials out of shared memory.
 *
 * @remarks
 * The issue-scoped `Triage investigation` document already holds the customer,
 * the exact queries, and the raw evidence, under that ticket's visibility.
 * This record is the sanitized pattern needed to recognize a recurrence, plus
 * links back to the source for anyone authorized to read it. Everything here
 * is bounded: a case is a projection, not a transcript.
 */

/** How the investigation ended. */
export const CLASSIFICATIONS = [
  "user_error",
  "platform_limitation",
  "bug",
  "unproven",
] as const;

/** How much the evidence supports the conclusion. */
export const CONFIDENCES = ["low", "medium", "high"] as const;

/** Lifecycle of a stored revision. */
export const CASE_STATUSES = [
  "active",
  "superseded",
  "corrected",
  "obsolete",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type CaseStatus = (typeof CASE_STATUSES)[number];

/**
 * Patterns that must never reach shared memory.
 *
 * @remarks
 * Every literal is fixed, so nothing here is built from data. Input length is
 * bounded by the schema before any of these run. The list is high-signal on
 * purpose: it catches the shapes that identify a customer or leak a secret,
 * and it is not an attempt to detect prose that merely mentions one.
 */
const FORBIDDEN = [
  { label: "an email address", pattern: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/ },
  {
    label: "a connection string",
    pattern: /\b(?:postgres|postgresql|mysql|mongodb)(?:\+srv)?:\/\//i,
  },
  {
    label: "a credential-shaped token",
    pattern:
      /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bghp_[A-Za-z0-9]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  },
  { label: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  {
    label: "a JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  },
  {
    label: "an inline secret",
    pattern: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i,
  },
] as const;

/** A customer organization or user id, which identifies a customer. */
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * The first reason `value` may not be stored, or null when it is clean.
 *
 * @param allowIdentifiers - Set on fields that legitimately carry opaque
 * vendor ids (evidence handles). It relaxes only the UUID rule; credentials
 * and email addresses stay forbidden everywhere.
 */
export function forbiddenReason(
  value: string,
  allowIdentifiers = false
): string | null {
  for (const { label, pattern } of FORBIDDEN) {
    if (pattern.test(value)) {
      return `contains ${label}`;
    }
  }
  if (!allowIdentifiers && UUID.test(value)) {
    return "contains a UUID, which identifies an organization or user";
  }
  return null;
}

/** Bounded free text that must pass the data-minimization guards. */
const clean = (max: number, allowIdentifiers = false) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => forbiddenReason(value, allowIdentifiers) === null, {
      error: (issue) =>
        `Value ${forbiddenReason(String(issue.input), allowIdentifiers)}. Keep customer identity and credentials in the Triage investigation document.`,
    });

const cleanList = (items: number, max: number, allowIdentifiers = false) =>
  z.array(clean(max, allowIdentifiers)).max(items).default([]);

/** Longest URL accepted for a link back to the source ticket or document. */
const MAX_URL_LENGTH = 500;

/**
 * A link back to the source, restricted to what a Linear link actually is.
 *
 * @remarks
 * `z.url()` defers to the WHATWG parser, which accepts userinfo:
 * `https://user:secret@host/path` is a valid URL, and both URL fields are
 * stored and returned in the model projection, so a credential parked in the
 * authority would sail past every other guard in this file. Reject userinfo
 * outright, require https, and run the same forbidden-pattern check over the
 * decoded URL. Opaque identifiers are allowed, because a link back to the
 * source is the same category as an evidence handle.
 */
const sourceUrl = () =>
  z
    .url()
    .max(MAX_URL_LENGTH)
    .refine((value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol !== "https:") {
        return false;
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return false;
      }
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // A malformed escape sequence stays as written and is checked as-is.
      }
      return forbiddenReason(decoded, true) === null;
    }, "Use a plain https link to the source, with no credentials in it.");

const featureKey = z.enum(FEATURE_KEYS);

/**
 * The write payload. `primaryFeatureKey` is absent on purpose: the executor
 * derives it from `linearProjectId`, so the model cannot choose the bucket a
 * case lands in.
 */
export const casePayloadSchema = z
  .object({
    affectedFeatureKeys: z
      .array(featureKey)
      .max(MAX_SCOPE_ENTRIES)
      .default([])
      .describe(
        "Other features this investigation showed evidence of affecting. Evidence, not suspicion. Empty is normal."
      ),
    affectedOrgCount: z.int().min(0).max(10_000_000).optional(),
    affectedUserCount: z.int().min(0).max(10_000_000).optional(),
    claim: clean(400).describe("The Step 4.1 testable claim, in one sentence."),
    codePaths: cleanList(10, 200).describe(
      "Files and functions the claim runs through, from Step 4.2."
    ),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    component: clean(80)
      .optional()
      .describe("Normalized component name, when one is clear."),
    confidence: z.enum(CONFIDENCES),
    countedAt: z.iso
      .date()
      .optional()
      .describe(
        "The date the affected counts were queried. Required whenever either count is given."
      ),
    dependencyKeys: z
      .array(
        z
          .string()
          .trim()
          .max(40)
          .refine(
            isDependencyKey,
            "Use a short lowercase key like `instantly`."
          )
      )
      .max(MAX_SCOPE_ENTRIES)
      .default([])
      .describe(
        "Shared systems involved: instantly, webhooks, inngest, authentication, billing."
      ),
    errorSignatures: cleanList(8, 200).describe(
      "Error identifiers or messages with secrets and identifiers removed."
    ),
    evidenceRefs: cleanList(10, 200, true).describe(
      "Stable handles only: Sentry issue ids, Inngest run ids, provider event ids, the document link. Never a payload."
    ),
    linearProjectId: z
      .uuid()
      .describe("The source issue's Linear project id. It picks the feature."),
    observedFrom: z.iso.datetime().optional(),
    observedTo: z.iso.datetime().optional(),
    provider: clean(60).optional(),
    resolution: clean(1000)
      .optional()
      .describe("The fix or the customer unblock, when one is known."),
    rootCause: clean(1000).describe("The evidence-backed conclusion."),
    ruledOut: cleanList(10, 200).describe(
      "Conclusions that were ruled out, not the queries that ruled them out."
    ),
    sourceDocumentUrl: sourceUrl().optional(),
    sourceIssueId: z
      .string()
      .trim()
      .regex(/^[A-Z]{2,10}-\d{1,9}$/, "A Linear identifier such as ENG-12345."),
    sourceIssueUrl: sourceUrl(),
    symptoms: cleanList(8, 200).describe(
      "What the user saw, in the product's own words."
    ),
  })
  .check((ctx) => {
    // A count without the date it was taken is unusable: a blast radius ages,
    // and the reader cannot tell whether the figure is a week or a year old.
    // `investigation_cases_counted_at_check` enforces this in the database too;
    // catching it here turns a raw Postgres error after a completed
    // investigation into an input error the model can fix on the spot.
    const { affectedOrgCount, affectedUserCount, countedAt } = ctx.value;
    if (
      countedAt === undefined &&
      (affectedOrgCount !== undefined || affectedUserCount !== undefined)
    ) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message:
          "countedAt is required whenever an affected count is given. Record the date the count was queried.",
        path: ["countedAt"],
      });
    }
  });

export type CasePayload = z.output<typeof casePayloadSchema>;

/** A case as it is handed back to the model: a projection, never a row. */
export const caseProjectionSchema = z.object({
  affectedFeatureKeys: z.array(z.string()),
  affectedOrgCount: z.number().nullable(),
  affectedUserCount: z.number().nullable(),
  caseId: z.string(),
  claim: z.string(),
  classification: z.enum(CLASSIFICATIONS),
  component: z.string().nullable(),
  confidence: z.enum(CONFIDENCES),
  correctsEarlierConclusion: z.boolean(),
  countedAt: z.string().nullable(),
  dependencyKeys: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  matchedOn: z.enum(["primary_feature", "affected_feature", "dependency"]),
  observedFrom: z.string().nullable(),
  observedTo: z.string().nullable(),
  primaryFeatureKey: z.string(),
  provider: z.string().nullable(),
  recordedAt: z.string(),
  resolution: z.string().nullable(),
  rootCause: z.string(),
  sourceDocumentUrl: z.string().nullable(),
  sourceIssueId: z.string(),
  sourceIssueUrl: z.string(),
});

export type CaseProjection = z.infer<typeof caseProjectionSchema>;

/**
 * The text a case is searched on. Built here rather than in a generated
 * column so the tsvector expression stays a plain immutable `to_tsvector` call
 * on one parameter.
 */
export function searchText(
  payload: Pick<
    CasePayload,
    | "claim"
    | "codePaths"
    | "component"
    | "errorSignatures"
    | "provider"
    | "rootCause"
    | "symptoms"
  >
): string {
  return [
    payload.claim,
    payload.rootCause,
    payload.component ?? "",
    payload.provider ?? "",
    ...payload.symptoms,
    ...payload.errorSignatures,
    ...payload.codePaths,
  ]
    .filter((part) => part !== "")
    .join(" \n");
}
