import { defineAgent } from "eve";
import { MODELS } from "../../lib/models.js";

/**
 * Station 2: analysis and planning.
 *
 * @remarks
 * Works from a live checkout of the factory repository (this station's
 * sandbox clones it at template build), so the plan names real files and the
 * repository's actual conventions instead of guesses. It plans; it never
 * writes the implementation. The acceptance criteria it produces are the
 * contract the reviewer later judges the implementation against, verbatim.
 */
export default defineAgent({
  description:
    "Analyze a classified work item against the real repository checkout and produce an " +
    "implementation plan: problem statement, approach, ordered steps, affected files, " +
    "risks, acceptance criteria, and test strategy. Planning only; writes no code. The " +
    "caller passes the work item, its classification, and any research findings in the " +
    "message.",
  model: MODELS.analyst,
  outputSchema: {
    additionalProperties: false,
    properties: {
      acceptance_criteria: {
        description:
          "Objective, testable criteria the reviewer will check one by one, verbatim.",
        items: { type: "string" },
        minItems: 1,
        type: "array",
      },
      affected_surface: {
        description:
          "Files, modules, interfaces, or systems the change will touch; anything with a public contract called out.",
        items: { type: "string" },
        type: "array",
      },
      approach: {
        description:
          "The chosen solution strategy, and briefly the main alternative rejected and why.",
        type: "string",
      },
      assumptions: {
        description:
          "Assumptions the plan rests on, stated so the implementer and reviewer can see them.",
        items: { type: "string" },
        type: "array",
      },
      open_questions: {
        description:
          "External facts the plan could not resolve from the repository; surfaced instead of guessed.",
        items: { type: "string" },
        type: "array",
      },
      plan: {
        description:
          "Ordered, concrete steps; each independently verifiable. The smallest change that fully solves the problem.",
        items: { type: "string" },
        minItems: 1,
        type: "array",
      },
      problem_statement: {
        description:
          "What is actually wrong or wanted, restated as a precise engineering problem.",
        type: "string",
      },
      risks: {
        description:
          "What could break, edge cases, migration or compatibility concerns, and how the plan mitigates each.",
        items: { type: "string" },
        type: "array",
      },
      test_strategy: {
        description:
          "What should be tested and how (unit, integration, manual), grounded in the repository's own test setup.",
        type: "string",
      },
    },
    required: [
      "problem_statement",
      "approach",
      "plan",
      "affected_surface",
      "risks",
      "acceptance_criteria",
      "test_strategy",
      "assumptions",
      "open_questions",
    ],
    type: "object",
  },
});
