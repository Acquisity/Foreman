import { defineDynamic, defineSkill } from "eve/skills";
import { PIPELINE } from "../lib/prompts.js";

// The full station procedure as a load-on-demand skill, advertised to every session. The
// general prompt carries no inline pipeline and points here for real work items; autonomous
// intake surfaces embed the same PIPELINE constant in their system prompt, so the skill is
// redundant there but harmless to advertise. Resolved at turn scope for the same reason as the
// instructions resolver: sessions predating a deploy never re-fire session.started.
export default defineDynamic({
  events: {
    "turn.started": (_event, _ctx) =>
      defineSkill({
        description:
          "Load when the conversation asks Foreman to actually fix, build, or change " +
          "something in the target repository: the full station pipeline procedure, from " +
          "grounding the work item through classifier, analyst, implementer, reviewer, and " +
          "the draft pull request.",
        markdown: PIPELINE,
      }),
  },
});
