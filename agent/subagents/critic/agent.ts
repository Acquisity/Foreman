import { defineAgent, defineDynamic } from "eve";
import { z } from "zod";
import { modelFor, resolveModel } from "../../lib/models.js";

/**
 * The twelve review criteria, in the order the critic judges them. A review
 * that ran carries exactly one result per slug; a review that could not start
 * carries none and is always INSUFFICIENT_EVIDENCE.
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

export const CRITIC_RESULTS = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

const text = z.string().trim().min(1);

/**
 * The reply contract instructions.md states, as the one schema Foreman reads
 * a critic result against. It is never passed to the child: see below.
 */
export const criticReplySchema = z.strictObject({
  advisory_notes: z.array(z.string()),
  blocking_findings: z.array(
    z.strictObject({
      claim: text,
      evidence: text,
      impact: text,
      next_check: text,
    })
  ),
  criteria_results: z
    .array(
      z.strictObject({
        criterion: z.enum(CRITIC_CRITERIA),
        evidence: text,
        rationale: text,
        result: z.enum(CRITIC_RESULTS),
      })
    )
    .max(CRITIC_CRITERIA.length),
  reviewed: z.strictObject({
    commit: z.string(),
    document_id: z.string(),
    document_updated_at: z.string(),
    issue_id: z.string(),
  }),
  summary: text,
  verdict: z.enum(CRITIC_VERDICTS),
});
export type CriticReply = z.infer<typeof criticReplySchema>;

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
 * The reply shape lives in instructions.md, which is the only output contract.
 * Callers pass no schema: PR #53 failed in production because the live call
 * overrode the child's declared shape and nothing downstream could read it.
 */
export default defineAgent({
  description:
    "Independently review a completed triage investigation before Foreman persists or routes it. " +
    "Called once per ticket, and once more after Foreman has adjudicated an objection. Pass the source issue id, the review kind, the Triage investigation document id " +
    "and its updatedAt, the repository commit the investigation read, and Foreman's proposed decisions " +
    "(classification, unblock, handling path, state, priority, labels, hotlane proposal, master candidate). " +
    "Returns APPROVE, CHALLENGE, or INSUFFICIENT_EVIDENCE with a result for each of twelve criteria. " +
    "Read-only: never writes to Linear, repositories, databases, providers, Slack, or memory.",
  // A model instance (modelFor routes Claude through the CLI Proxy) can only be
  // returned at step start; Eve cannot serialize one into a session selection.
  model: defineDynamic({
    events: {
      "step.started": async () => modelFor(await resolveModel("critic")),
    },
  }),
});
