import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";

/**
 * The twelve review criteria, in the order the critic judges them. Every
 * verdict carries exactly one result per slug.
 */
export const CRITIC_CRITERIA = [
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

export const CRITIC_VERDICTS = [
  "APPROVE",
  "CHALLENGE",
  "INSUFFICIENT_EVIDENCE",
] as const;

/**
 * Triage critic: an independent, read-only review of a completed triage
 * investigation before Foreman persists or routes it.
 *
 * @remarks
 * Runs on a different model vendor from the orchestrator on purpose. It reads
 * the issue's `Triage investigation` document and Foreman's proposed decisions,
 * verifies the claims that would change the outcome against their sources at
 * the recorded commit, and returns one verdict. It never writes anything.
 *
 * This schema is the only output contract. The caller must not pass an
 * `outputSchema` of its own: PR #53 failed in production because the live call
 * overrode the child's declared shape and nothing downstream could read it.
 */
export default defineAgent({
  description:
    "Independently review a completed triage investigation before Foreman persists or routes it. " +
    "Pass the source issue id, the Triage investigation document id and its updatedAt, the repository " +
    "commit the investigation read, Foreman's proposed decisions (classification, unblock, handling path, " +
    "state, priority, labels, hotlane proposal, master candidate), the attempt number (1 or 2), and on " +
    "attempt 2 the criteria that failed last time or the note that a prior approval was invalidated. " +
    "Returns APPROVE, CHALLENGE, or INSUFFICIENT_EVIDENCE with a result for each of twelve criteria. " +
    "Read-only: never writes to Linear, repositories, databases, providers, Slack, or memory.",
  model: defineDynamic({
    events: {
      "session.started": () => resolveModel("critic"),
    },
  }),
  outputSchema: {
    additionalProperties: false,
    properties: {
      advisory_notes: {
        description:
          "Non-blocking observations. Never a reason to withhold APPROVE.",
        items: { type: "string" },
        type: "array",
      },
      blocking_findings: {
        description:
          "Every problem that blocks approval. Empty when the verdict is APPROVE.",
        items: {
          additionalProperties: false,
          properties: {
            claim: {
              description:
                "The exact claim or proposed decision being challenged.",
              type: "string",
            },
            evidence: {
              description:
                "The concrete evidence, or the specific missing evidence, with its source.",
              type: "string",
            },
            impact: {
              description:
                "Why it matters: customer, engineering, privacy, or operational impact.",
              type: "string",
            },
            next_check: {
              description:
                "The smallest check or correction that would resolve this finding.",
              type: "string",
            },
          },
          required: ["claim", "evidence", "impact", "next_check"],
          type: "object",
        },
        type: "array",
      },
      criteria_results: {
        description:
          "Exactly one entry per criterion slug, in order. FAIL needs the blocking evidence so a recheck has an exact target. NOT_APPLICABLE never appears in an APPROVE.",
        items: {
          additionalProperties: false,
          properties: {
            criterion: { enum: [...CRITIC_CRITERIA], type: "string" },
            evidence: {
              description:
                "What was read or queried to judge this criterion, with its source.",
              type: "string",
            },
            rationale: { type: "string" },
            result: {
              enum: ["PASS", "FAIL", "NOT_APPLICABLE"],
              type: "string",
            },
          },
          required: ["criterion", "result", "evidence", "rationale"],
          type: "object",
        },
        maxItems: CRITIC_CRITERIA.length,
        minItems: CRITIC_CRITERIA.length,
        type: "array",
      },
      reviewed: {
        additionalProperties: false,
        description:
          "Echo of exactly what was reviewed. Foreman compares this to the current document before acting on an APPROVE.",
        properties: {
          commit: {
            description:
              "The repository commit the review verified code against, as found in the shared checkout.",
            type: "string",
          },
          document_id: { type: "string" },
          document_updated_at: {
            description:
              "The document updatedAt value that was reviewed, verbatim.",
            type: "string",
          },
          issue_id: { type: "string" },
        },
        required: ["issue_id", "document_id", "document_updated_at", "commit"],
        type: "object",
      },
      summary: {
        description: "One paragraph: the verdict and what drove it.",
        type: "string",
      },
      verdict: { enum: [...CRITIC_VERDICTS], type: "string" },
    },
    required: [
      "verdict",
      "reviewed",
      "criteria_results",
      "blocking_findings",
      "advisory_notes",
      "summary",
    ],
    type: "object",
  },
});
