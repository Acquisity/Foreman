import { defineDynamic, defineInstructions } from "eve/instructions";
import { FACTORY_PROMPT, GENERAL_PROMPT } from "../lib/prompts.js";
import { isAutonomous } from "../lib/trust.js";

// The agent's system prompt, resolved by caller: unattended factory runs (an issue labeled
// `factory`, red CI on a factory PR) run under the autonomous principal and get the full
// factory prompt inline; every interactive session gets the general profile, which reaches
// the same pipeline through the factory-pipeline skill. Resolved at turn scope rather than
// session scope because a session-scope result is written once at session start, and sessions
// that predate a deploy never re-fire session.started: with no static instructions compiled,
// those sessions would run promptless forever. Re-resolving each turn keeps them covered, and
// since the caller never changes within a session the content is identical every turn, so the
// provider prompt cache stays warm. The resolver is total and synchronous over compiled
// constants, and anything unrecognized falls through to the general prompt, so a resolver
// failure can never strip the pipeline from autonomous intake surfaces.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: isAutonomous(ctx.session.auth.current)
          ? FACTORY_PROMPT
          : GENERAL_PROMPT,
      }),
  },
});
