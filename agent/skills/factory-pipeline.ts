import { defineSkill } from "eve/skills";
import { PIPELINE } from "../lib/prompts.js";

// The full station procedure as a load-on-demand skill. Chat sessions carry a lean prompt and
// reach the pipeline through this skill; the body is the same PIPELINE constant the factory
// prompt embeds inline, so the two can never drift.
export default defineSkill({
  description:
    "Load when a conversation asks Foreman to actually fix, build, or change something in the " +
    "target repository: the full station pipeline procedure, from grounding the work item " +
    "through classifier, analyst, implementer, reviewer, and the draft pull request.",
  markdown: PIPELINE,
});
