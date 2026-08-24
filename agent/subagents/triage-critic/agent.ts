import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";

export default defineAgent({
  description:
    "Independently challenge a completed customer-bug diagnosis before Foreman performs structural Linear, routing, notification, or investigation-memory writes. Read the immutable packet, verify its repository evidence and optionally search investigation memory, then return APPROVE, CHALLENGE, or INSUFFICIENT_EVIDENCE for that exact evidence revision. Never writes or publishes findings.",
  model: defineDynamic({
    events: {
      "session.started": () => resolveModel("triageCritic"),
    },
  }),
  outputSchema: {
    additionalProperties: false,
    properties: {
      advisory_notes: {
        items: { type: "string" },
        type: "array",
      },
      blocking_findings: {
        items: {
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            evidence: { type: "string" },
            impact: { type: "string" },
            next_check: { type: "string" },
          },
          required: ["claim", "evidence", "impact", "next_check"],
          type: "object",
        },
        type: "array",
      },
      criteria_results: {
        items: {
          additionalProperties: false,
          properties: {
            criterion: {
              enum: [
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
              ],
              type: "string",
            },
            evidence: { type: "string" },
            rationale: { type: "string" },
            result: {
              enum: ["PASS", "FAIL", "NOT_APPLICABLE"],
              type: "string",
            },
          },
          required: ["criterion", "result", "evidence", "rationale"],
          type: "object",
        },
        maxItems: 12,
        minItems: 12,
        type: "array",
      },
      evidence_revision: { type: "string" },
      reviewer_model: { type: "string" },
      summary: { type: "string" },
      verdict: {
        enum: ["APPROVE", "CHALLENGE", "INSUFFICIENT_EVIDENCE"],
        type: "string",
      },
    },
    required: [
      "verdict",
      "evidence_revision",
      "reviewer_model",
      "criteria_results",
      "blocking_findings",
      "advisory_notes",
      "summary",
    ],
    type: "object",
  },
});
