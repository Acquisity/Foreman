import { defineDynamic, defineSkill } from "eve/skills";
import { factorySkillAvailable } from "../lib/factory-lane.js";
import { PIPELINE } from "../lib/prompts.js";

// The full station procedure as a load-on-demand skill, offered only to the lanes that
// can take the factory path. `factorySkillAvailable` owns that decision: an autonomous run
// gets the same PIPELINE constant inline in its system prompt and needs no duplicate skill,
// ordinary Slack carries neither, and everything else needs explicit factory intent or a
// selected repository. Resolved at turn scope for the same reason as the instructions
// resolver: sessions predating a deploy never re-fire session.started, and the stamps this
// reads are per-delivery, so a later message asking for the factory is honored on its turn.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      factorySkillAvailable(ctx.session.auth.current)
        ? defineSkill({
            description:
              "Load when the user explicitly requests factory mode, or a task has substantial " +
              "complexity, uncertainty, risk, or review depth: repository intake, classifier, " +
              "root-cause investigator, analyst, implementer, independent reviewer, pull request " +
              "stabilization, and readiness. Do not load merely because a small task changes files.",
            markdown: PIPELINE,
          })
        : null,
  },
});
