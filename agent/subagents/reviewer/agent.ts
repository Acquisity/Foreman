import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";

/**
 * Station 4: independent review.
 *
 * @remarks
 * Runs on a different model vendor than the implementer on purpose: fresh
 * eyes are the station's point, and a different model doesn't share the
 * implementer's idiom or blind spots. It fetches the pushed branch into its
 * own checkout and judges the real diff against the analyst's acceptance
 * criteria; it never modifies code. Its verdict routes the pipeline: approve
 * opens a normal PR, request_changes loops back to the implementer, and an
 * unchanged blocker set escalates after its third consecutive record.
 */
export default defineAgent({
  description:
    "Independently review a pushed factory branch against the original work item and its " +
    "acceptance criteria: fetch the branch, read the real diff, re-run cheap checks, and " +
    "return approve, request_changes, or reject with specific findings. Never modifies " +
    "code. The caller passes the work item, the analysis with acceptance criteria, the " +
    "branch name, exact pushed head SHA, and the implementer's report in the message, plus an artifact id when " +
    "the analyst saved its full detail as one.",
  model: defineDynamic({
    events: {
      "session.started": () => resolveModel("reviewer"),
    },
  }),
  outputSchema: {
    additionalProperties: false,
    properties: {
      blocking_findings: {
        description:
          "Problems that block shipping: each names where it is, what is wrong, and why it matters.",
        items: { type: "string" },
        type: "array",
      },
      criteria_results: {
        description:
          "One entry per acceptance criterion from the analysis, judged individually.",
        items: {
          additionalProperties: false,
          properties: {
            criterion: {
              description: "The acceptance criterion, verbatim.",
              type: "string",
            },
            evidence: {
              description:
                "What in the diff or verification output shows it passing or failing.",
              type: "string",
            },
            pass: { type: "boolean" },
          },
          required: ["criterion", "pass", "evidence"],
          type: "object",
        },
        type: "array",
      },
      suggestions: {
        description: "Advisory notes that do not block shipping.",
        items: { type: "string" },
        type: "array",
      },
      summary: {
        description: "One paragraph: the verdict and what drove it.",
        type: "string",
      },
      verdict: {
        enum: ["approve", "request_changes", "reject"],
        type: "string",
      },
    },
    required: [
      "verdict",
      "criteria_results",
      "blocking_findings",
      "suggestions",
      "summary",
    ],
    type: "object",
  },
});
