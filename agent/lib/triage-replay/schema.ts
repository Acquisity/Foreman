import { z } from "zod";

/**
 * The triage replay's three file shapes (ENG-16049): a frozen case, a label,
 * and one replay result. The replay reads cases only; labels are read by the
 * trusted scorer alone, and held-out labels never sit in this repository.
 */

/** A field rebuilt as of the case's creation, or `unknown` when history can't settle it. */
const asOf = <T extends z.ZodType>(value: T) =>
  z.union([value, z.literal("unknown")]);

export const relatedIssueSchema = z.strictObject({
  assignee: asOf(z.string().nullable()),
  createdAt: z.iso.datetime(),
  description: asOf(z.string()),
  id: z.string().regex(/^[A-Z]+-\d+$/),
  labels: asOf(z.array(z.string())),
  parent: asOf(z.string().nullable()),
  state: asOf(z.string()),
  title: asOf(z.string()),
});

/**
 * The source ticket's fields as first filed. A case that records none seeds
 * the ticket cleared, which a closure that preserves the owner can't match.
 */
export const asFiledSchema = z.strictObject({
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  parent: z.string().nullable(),
  priority: z.int().min(0).max(4),
  project: z.string().nullable(),
});

export const STRATA = [
  "bug_master",
  "duplicate",
  "duplicate_hard_negative",
  "platform_limitation",
  "user_error",
  "unproven",
  "billing",
] as const;

export const triageCaseSchema = z.strictObject({
  asFiled: asFiledSchema.optional(),
  createdAt: z.iso.datetime(),
  flags: z.strictObject({
    alreadyFixedAtTriage: z.boolean(),
    descriptionEditedAfterCreate: z.boolean(),
    needsProductionData: z.boolean(),
  }),
  id: z.string().regex(/^ENG-\d+$/),
  lane: z.string().min(1),
  provenance: z.literal("seeded"),
  relatedSnapshot: z.array(relatedIssueSchema),
  repoCommitAtCreate: z.string().regex(/^[0-9a-f]{40}$/),
  stratum: z.enum(STRATA),
  ticket: z.strictObject({
    attachmentKinds: z.array(z.string()),
    description: z.string(),
    title: z.string().min(1),
  }),
});
export type TriageCase = z.infer<typeof triageCaseSchema>;

export const triageLabelSchema = z
  .strictObject({
    classification: z.string().nullable(),
    duplicateOf: z.array(z.string()).nullable(),
    fixCommit: z.string().nullable(),
    fixPr: z.int().positive().nullable(),
    id: z.string().regex(/^ENG-\d+$/),
    insufficient: z.boolean(),
    labelSource: z.array(z.string()),
    /** The master or parent that survived human edits, when there is one. */
    master: z.string().nullable().optional(),
    notes: z.string(),
    outcomeAt: z.iso.datetime().nullable(),
    owner: z.string().nullable(),
    path: z.string().nullable(),
    project: z.string().nullable(),
    rootCause: z
      .strictObject({
        files: z.array(z.string()),
        functions: z.array(z.string()),
        text: z.string().min(1),
      })
      .nullable(),
    verdict: z.enum(["route", "unproven"]),
  })
  .refine((label) => label.insufficient || label.labelSource.length > 0, {
    message: "a label with ground truth names its human source",
  })
  .refine((label) => label.insufficient || label.outcomeAt !== null, {
    message: "a label with ground truth says when its human outcome happened",
  });
export type TriageLabel = z.infer<typeof triageLabelSchema>;

export const NEW_MASTER = "new";

/** Where a run input came from: seeded from the case, or written during this replay. */
export const PROVENANCE = ["seeded", "generated"] as const;

export const RESULT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "boundary_error",
] as const;

/** One replay of one case, written by the runner and read by the scorer. */
export const triageResultSchema = z.strictObject({
  caseId: z.string().regex(/^ENG-\d+$/),
  cohortSha256: z.string().regex(/^[0-9a-f]{64}$/),
  critic: z
    .strictObject({
      blockingFindings: z.int().nonnegative(),
      failedCriteria: z.int().nonnegative(),
      verdict: z.enum([
        "APPROVE",
        "CHALLENGE",
        "INSUFFICIENT_EVIDENCE",
        "failed",
      ]),
    })
    .nullable(),
  /** The last document version the run saved, read back from the simulated store. */
  document: z
    .strictObject({ text: z.string(), updatedAt: z.string() })
    .nullable(),
  /** The model spend charged to this replay, an estimate: a replay can't meter most of its cost. */
  estimatedUsd: z.number().nonnegative(),
  evidenceMisses: z.array(z.string()),
  /** The last decision for the case, with what the store applied to the case ticket. */
  final: z
    .strictObject({
      assignee: z.string().nullable(),
      classification: z.string().nullable(),
      duplicateOf: z.string().nullable(),
      master: z.string().nullable(),
      outcome: z.enum(["route", "unproven"]),
      path: z.string().nullable(),
      project: z.string().nullable(),
    })
    .nullable(),
  /** The Foreman commit the replay server ran, or `unknown` when its deployment names none. */
  foremanCommit: z.string().min(1),
  /** Every input the run saw, whole, with provenance and, for evidence as of the case, the case's creation time. */
  inputs: z.array(
    z.strictObject({
      availableAt: z.iso.datetime().nullable(),
      content: z.string(),
      provenance: z.enum(PROVENANCE),
      source: z.string().min(1),
    })
  ),
  listMembershipUnknown: z.array(
    z.enum(["labels", "projects", "states", "users"])
  ),
  run: z.int().positive(),
  runId: z.string().min(1),
  /** When the server started this replay. */
  startedAt: z.iso.datetime(),
  status: z.enum(RESULT_STATUSES),
});
export type TriageResult = z.infer<typeof triageResultSchema>;
