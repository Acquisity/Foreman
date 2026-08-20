import { defineDynamic, defineSkill } from "eve/skills";
import { PIPELINE } from "../lib/prompts.js";
import { isAutonomous } from "../lib/trust.js";

// The full station procedure as a load-on-demand skill. Interactive sessions get the general
// prompt plus this loadable skill; autonomous sessions get the inline pipeline (the same
// PIPELINE constant embedded in their system prompt) and no duplicate skill, so this resolver
// returns null for them. Resolved at turn scope for the same reason as the instructions
// resolver: sessions predating a deploy never re-fire session.started.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      isAutonomous(ctx.session.auth.current)
        ? null
        : defineSkill({
            description:
              "Load when the user explicitly requests factory mode, or a task has substantial " +
              "complexity, uncertainty, risk, or review depth: repository intake, classifier, " +
              "root-cause investigator, analyst, implementer, independent reviewer, pull request " +
              "stabilization, and readiness. Do not load merely because a small task changes files.",
            markdown: PIPELINE,
          }),
  },
});
