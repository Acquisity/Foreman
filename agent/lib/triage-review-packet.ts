import { createHash } from "node:crypto";
import { z } from "zod";

export const TRIAGE_REVIEW_PACKET_VERSION = 1 as const;
export const TRIAGE_REVIEW_PACKET_DIRECTORY =
  "/workspace/.foreman/triage-review-packets";

export const TRIAGE_CRITIC_CRITERIA = [
  "claim_fidelity",
  "reachability",
  "causality",
  "alternatives",
  "evidence_integrity",
  "impact_measurement",
  "classification",
  "core_function_and_hotlane",
  "master_match",
  "unblock_safety",
  "privacy_boundary",
  "engineering_handoff",
] as const;

export const evidenceRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const boundedTextList = (maxItems: number, maxLength: number) =>
  z.array(boundedText(maxLength)).max(maxItems);

export const linearIssueIdentifierSchema = z
  .string()
  .regex(/^[A-Z]{2,10}-\d{1,9}$/u);

const observedEvidenceEntrySchema = z.object({
  handle: boundedText(500),
  lane: boundedText(80),
  observedAt: z.iso.datetime(),
  status: z.enum(["VERIFIED", "CONTRADICTED"]),
  summary: boundedText(2000),
});

const evidenceEntrySchema = z.discriminatedUnion("status", [
  observedEvidenceEntrySchema,
  z.object({
    lane: boundedText(80),
    observedAt: z.iso.datetime(),
    status: z.literal("NOT_APPLICABLE"),
    summary: boundedText(2000),
  }),
  z.object({
    blockerReason: boundedText(1000),
    lane: boundedText(80),
    observedAt: z.iso.datetime(),
    status: z.literal("COULD_NOT_RUN"),
    summary: boundedText(2000),
  }),
]);

const causalKey = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._:/#+-]*$/u);

export const causalIdentitySchema = z
  .object({
    causalPathKeys: z.array(causalKey).min(1).max(20),
    failingInvariantKey: causalKey,
    preventionOutcomeKey: causalKey,
    repositoryKey: causalKey,
    triggerConditionKeys: z.array(causalKey).min(1).max(20),
  })
  .superRefine((input, ctx) => {
    for (const field of ["causalPathKeys", "triggerConditionKeys"] as const) {
      if (new Set(input[field]).size !== input[field].length) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must not contain duplicate keys.`,
          path: [field],
        });
      }
    }
  });
export type CausalIdentity = z.infer<typeof causalIdentitySchema>;

const diagnosisSchema = z.object({
  blastRadius: z
    .object({
      affectedOrgCount: z.int().min(0).max(10_000_000).optional(),
      affectedUserCount: z.int().min(0).max(10_000_000).optional(),
      confirmedAffected: boundedText(500),
      countedAt: z.iso.date().optional(),
      limitations: boundedText(1000),
      method: boundedText(2000),
      potentiallyExposed: boundedText(500),
      window: boundedText(500),
    })
    .superRefine((input, ctx) => {
      if (
        (input.affectedOrgCount !== undefined ||
          input.affectedUserCount !== undefined) &&
        input.countedAt === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Affected counts require the date they were measured.",
          path: ["countedAt"],
        });
      }
    }),
  causalIdentity: causalIdentitySchema,
  codeAnchor: z.object({
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    paths: boundedTextList(10, 200).min(1),
    repository: boundedText(200),
  }),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  customerUnblock: boundedText(2000),
  disprovingObservation: boundedText(2000),
  evidenceLedger: z.array(evidenceEntrySchema).min(1).max(100),
  hypotheses: z
    .array(
      z.object({
        disprovingObservation: boundedText(1000),
        hypothesis: boundedText(1000),
        rank: z.int().min(1).max(5),
        status: z.enum(["ACTIVE", "RULED_OUT", "CONFIRMED"]),
        supportingObservation: boundedText(1000),
      })
    )
    .min(1)
    .max(5),
  inference: boundedTextList(50, 2000),
  mode: z.enum(["REPRODUCTION", "PRODUCTION_FORENSICS", "UNPROVEN"]),
  regressionSeam: boundedText(2000),
  rootCause: boundedText(1000),
  ruledOut: boundedTextList(50, 1000),
  unknowns: boundedTextList(50, 1000),
  verifiedFacts: boundedTextList(100, 2000),
});

const memoryResultSchema = z.object({
  available: z.boolean(),
  howUsed: boundedText(2000),
  matches: z
    .array(
      z.object({
        relevance: boundedText(1000),
        sourceIssueId: boundedText(40),
      })
    )
    .max(10),
  searched: z.boolean(),
});

const proposalSchema = z.object({
  classification: z.enum([
    "User Error",
    "Platform Limitation",
    "Bug",
    "Unproven",
  ]),
  coreFunctionImpact: boundedText(2000),
  hotlaneDecision: z.enum([
    "HOTLANE",
    "STANDARD_ENGINEERING",
    "NOT_ENGINEERING",
    "NEEDS_HUMAN_URGENT",
  ]),
  linearProjectId: z.uuid().nullable(),
  masterCandidateIssueId: linearIssueIdentifierSchema.optional(),
  masterEligibilityEvaluatedAt: z.iso.datetime(),
  masterRecencyPolicy: z.enum(["UNBOUNDED", "THIRTY_DAY"]),
  priority: z.enum(["Urgent", "High", "Medium", "Low", "None"]),
  staleMasterCandidateIssueId: linearIssueIdentifierSchema.optional(),
  structuralWrites: boundedTextList(50, 2000),
});

export const triageReviewPacketInputSchema = z
  .object({
    claim: boundedText(400),
    diagnosis: diagnosisSchema,
    duplicateCandidates: z
      .array(
        z.object({
          causalMatch: z.boolean(),
          issueId: linearIssueIdentifierSchema,
          outcomeMatch: z.boolean(),
          rationale: boundedText(2000),
        })
      )
      .max(25),
    masterCandidates: z
      .array(
        z.object({
          causalMatch: z.boolean(),
          createdAt: z.iso.datetime(),
          issueId: linearIssueIdentifierSchema,
          rationale: boundedText(2000),
        })
      )
      .max(25),
    memoryResults: memoryResultSchema,
    previousEvidenceRevision: evidenceRevisionSchema.optional(),
    proposal: proposalSchema,
    reviewAttempt: z.union([z.literal(1), z.literal(2)]),
    source: z.discriminatedUnion("kind", [
      z.object({
        boundedContext: boundedText(10_000),
        issueId: linearIssueIdentifierSchema,
        kind: z.literal("Linear"),
        workspaceIdentity: boundedText(1000),
      }),
      z.object({
        boundedContext: boundedText(10_000),
        conversationId: boundedText(100),
        conversationUrl: z.url().max(1000),
        kind: z.literal("Intercom"),
        workspaceIdentity: boundedText(1000),
      }),
    ]),
    targetedRecheckCriteria: z
      .array(z.enum(TRIAGE_CRITIC_CRITERIA))
      .max(12)
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.source.kind === "Linear" &&
      input.proposal.linearProjectId === null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Linear triage requires the source issue's project id.",
        path: ["proposal", "linearProjectId"],
      });
    }
    if (
      input.diagnosis.causalIdentity.repositoryKey !==
      input.diagnosis.codeAnchor.repository.toLowerCase()
    ) {
      ctx.addIssue({
        code: "custom",
        message: "The causal repository key must match the code anchor.",
        path: ["diagnosis", "causalIdentity", "repositoryKey"],
      });
    }
    if (
      input.reviewAttempt === 1 &&
      (input.previousEvidenceRevision !== undefined ||
        input.targetedRecheckCriteria !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A first review cannot name a previous revision or targeted recheck criteria.",
        path: ["reviewAttempt"],
      });
    }
    if (
      input.reviewAttempt === 2 &&
      (input.previousEvidenceRevision === undefined ||
        input.targetedRecheckCriteria === undefined ||
        input.targetedRecheckCriteria.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A second review requires the previous evidence revision and at least one targeted criterion.",
        path: ["reviewAttempt"],
      });
    }
    if (
      input.targetedRecheckCriteria !== undefined &&
      new Set(input.targetedRecheckCriteria).size !==
        input.targetedRecheckCriteria.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Targeted recheck criteria must be unique.",
        path: ["targetedRecheckCriteria"],
      });
    }
    if (
      input.proposal.masterCandidateIssueId !== undefined &&
      input.proposal.staleMasterCandidateIssueId !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A current and stale master candidate cannot both be selected.",
        path: ["proposal"],
      });
    }
  })
  .superRefine((input, ctx) => {
    if (
      new Set(input.masterCandidates.map(({ issueId }) => issueId)).size !==
      input.masterCandidates.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Master candidates must be unique by Linear issue id.",
        path: ["masterCandidates"],
      });
    }
    for (const field of [
      "masterCandidateIssueId",
      "staleMasterCandidateIssueId",
    ] as const) {
      const selected = input.proposal[field];
      if (
        selected !== undefined &&
        !input.masterCandidates.some(
          ({ causalMatch, issueId }) => causalMatch && issueId === selected
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "A selected master must appear once in the reviewed candidate set as a causal match.",
          path: ["proposal", field],
        });
      }
    }
    const evaluatedAt = Date.parse(input.proposal.masterEligibilityEvaluatedAt);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const selectedCandidate = (
      field: "masterCandidateIssueId" | "staleMasterCandidateIssueId"
    ) =>
      input.masterCandidates.find(
        ({ issueId }) => issueId === input.proposal[field]
      );
    const current = selectedCandidate("masterCandidateIssueId");
    const stale = selectedCandidate("staleMasterCandidateIssueId");
    for (const candidate of [current, stale]) {
      if (candidate && Date.parse(candidate.createdAt) > evaluatedAt) {
        ctx.addIssue({
          code: "custom",
          message:
            "A master cannot be created after the eligibility evaluation.",
          path: ["masterCandidates"],
        });
      }
    }
    if (
      input.proposal.masterRecencyPolicy === "UNBOUNDED" &&
      stale !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unbounded triage cannot replace a master as stale.",
        path: ["proposal", "staleMasterCandidateIssueId"],
      });
    }
    if (input.proposal.masterRecencyPolicy === "THIRTY_DAY") {
      if (
        current !== undefined &&
        evaluatedAt - Date.parse(current.createdAt) > thirtyDaysMs
      ) {
        ctx.addIssue({
          code: "custom",
          message: "A current 30-day master must be no more than 30 days old.",
          path: ["proposal", "masterCandidateIssueId"],
        });
      }
      if (
        stale !== undefined &&
        evaluatedAt - Date.parse(stale.createdAt) <= thirtyDaysMs
      ) {
        ctx.addIssue({
          code: "custom",
          message: "A stale 30-day master must be more than 30 days old.",
          path: ["proposal", "staleMasterCandidateIssueId"],
        });
      }
    }
    if (
      input.source.kind === "Intercom" &&
      input.proposal.masterRecencyPolicy !== "THIRTY_DAY"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Intercom intake requires the 30-day master policy.",
        path: ["proposal", "masterRecencyPolicy"],
      });
    }
  });

export const triageReviewPacketSchema =
  triageReviewPacketInputSchema.safeExtend({
    criticModel: boundedText(128),
    packetVersion: z.literal(TRIAGE_REVIEW_PACKET_VERSION),
  });

export type TriageReviewPacket = z.infer<typeof triageReviewPacketSchema>;
export type TriageReviewPacketInput = z.infer<
  typeof triageReviewPacketInputSchema
>;

export const stampTriageReviewPolicy = (
  input: TriageReviewPacketInput,
  options: { evaluatedAt: string; intakeOnly: boolean }
): TriageReviewPacketInput =>
  triageReviewPacketInputSchema.parse({
    ...input,
    proposal: {
      ...input.proposal,
      masterEligibilityEvaluatedAt: options.evaluatedAt,
      masterRecencyPolicy:
        input.source.kind === "Intercom" || options.intakeOnly
          ? "THIRTY_DAY"
          : "UNBOUNDED",
    },
  });

const criterionResultSchema = z.object({
  criterion: z.enum(TRIAGE_CRITIC_CRITERIA),
  evidence: boundedText(4000),
  rationale: boundedText(4000),
  result: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
});

export const triageCriticVerdictSchema = z
  .object({
    advisory_notes: boundedTextList(30, 2000),
    blocking_findings: z
      .array(
        z.object({
          claim: boundedText(2000),
          evidence: boundedText(4000),
          impact: boundedText(2000),
          next_check: boundedText(2000),
        })
      )
      .max(30),
    criteria_results: z.array(criterionResultSchema).length(12),
    evidence_revision: evidenceRevisionSchema,
    reviewer_model: boundedText(128),
    summary: boundedText(4000),
    verdict: z.enum(["APPROVE", "CHALLENGE", "INSUFFICIENT_EVIDENCE"]),
  })
  .superRefine((input, ctx) => {
    const actual = new Set(
      input.criteria_results.map(({ criterion }) => criterion)
    );
    for (const expected of TRIAGE_CRITIC_CRITERIA) {
      if (!actual.has(expected)) {
        ctx.addIssue({
          code: "custom",
          message: `Missing critic criterion: ${expected}`,
          path: ["criteria_results"],
        });
      }
    }
    const failures = input.criteria_results.filter(
      ({ result }) => result === "FAIL"
    );
    const passes = input.criteria_results.filter(
      ({ result }) => result === "PASS"
    );
    if (
      input.verdict === "APPROVE" &&
      (input.blocking_findings.length > 0 ||
        failures.length > 0 ||
        passes.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "An approved review requires supported criteria and cannot contain blocking findings or failures.",
        path: ["verdict"],
      });
    }
    if (
      input.verdict !== "APPROVE" &&
      (input.blocking_findings.length === 0 || failures.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "A non-approved review requires a blocking finding and a failed criterion.",
        path: ["verdict"],
      });
    }
  });

export type TriageCriticVerdict = z.infer<typeof triageCriticVerdictSchema>;

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

export const canonicalizeTriageReviewValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeTriageReviewValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, canonicalizeTriageReviewValue(entry)])
    );
  }
  return value;
};

export const serializeTriageReviewPacket = (
  packet: TriageReviewPacket
): string => JSON.stringify(canonicalizeTriageReviewValue(packet), null, 2);

export const hashTriageReviewPacket = (serialized: string): string =>
  createHash("sha256").update(serialized).digest("hex");

export const triageReviewPacketPath = (evidenceRevision: string): string =>
  `${TRIAGE_REVIEW_PACKET_DIRECTORY}/${evidenceRevision}.json`;
