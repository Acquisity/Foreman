import { defineAgent, defineDynamic } from "eve";
import { resolveModel } from "../../lib/models.js";

export default defineAgent({
  description:
    "Investigate a classified factory work item in the prepared repository before planning. Trace the relevant production and code paths, reproduce or bound the behavior, identify the root cause with concrete evidence, and return constraints for the analyst. Never modifies files.",
  model: defineDynamic({
    events: { "session.started": () => resolveModel("investigator") },
  }),
  outputSchema: {
    additionalProperties: false,
    properties: {
      evidence: { items: { type: "string" }, type: "array" },
      investigated_paths: { items: { type: "string" }, type: "array" },
      reproduction: { type: "string" },
      root_cause: { type: "string" },
      uncertainties: { items: { type: "string" }, type: "array" },
    },
    required: [
      "root_cause",
      "reproduction",
      "evidence",
      "investigated_paths",
      "uncertainties",
    ],
    type: "object",
  },
});
