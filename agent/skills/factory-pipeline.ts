import { defineDynamic, defineSkill } from "eve/skills";
import { isSlackSession, PIPELINE } from "../lib/prompts.js";

// The full station procedure as a load-on-demand skill, advertised only to Slack sessions: their
// chat prompt carries no inline pipeline and points here for real work items. Every other
// surface embeds the same PIPELINE constant in its system prompt already, so advertising the
// skill there would only invite a wasted load_skill turn that re-ingests duplicate text. Resolved
// at turn scope for the same reason as the instructions resolver: sessions predating a deploy
// never re-fire session.started.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      isSlackSession(ctx)
        ? defineSkill({
            description:
              "Load when the conversation asks Foreman to actually fix, build, or change " +
              "something in the target repository: the full station pipeline procedure, from " +
              "grounding the work item through classifier, analyst, implementer, reviewer, and " +
              "the draft pull request.",
            markdown: PIPELINE,
          })
        : null,
  },
});
