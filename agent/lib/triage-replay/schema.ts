import { z } from "zod";
import { criticVerdictSchema } from "../triage-log.js";

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

export const UNKNOWN_COMMIT = "unknown";

export const RESULT_STATUSES = ["completed", "failed", "cancelled"] as const;

export const triageResultSchema = z.strictObject({
  caseId: z.string().regex(/^ENG-\d+$/),
  critic: criticVerdictSchema.nullable(),
  diagnosis: z.string().nullable(),
  document: z
    .strictObject({ text: z.string(), updatedAt: z.string() })
    .nullable(),
  evidenceMisses: z.array(z.string()),
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
  foremanCommit: z.string().min(1),
  run: z.int().positive(),
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  status: z.enum(RESULT_STATUSES),
});
export type TriageResult = z.infer<typeof triageResultSchema>;
