import { defineDynamic, defineInstructions } from "eve/instructions";
import { CHAT_PROMPT, FACTORY_PROMPT, isSlackSession } from "../lib/prompts.js";

// The orchestrator's system prompt, resolved by channel: Slack sessions get the lean chat
// profile, every other surface gets the full factory prompt. Resolved at turn scope rather than
// session scope because a session-scope result is written once at session start, and sessions
// that predate a deploy never re-fire session.started: with no static instructions compiled,
// those sessions would run promptless forever. Re-resolving each turn keeps them covered, and
// since the channel never changes within a session the content is identical every turn, so the
// provider prompt cache stays warm. The resolver is total and synchronous over compiled
// constants, and anything unrecognized falls through to the factory prompt, so a resolver
// failure can never strip the pipeline from intake surfaces.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: isSlackSession(ctx) ? CHAT_PROMPT : FACTORY_PROMPT,
      }),
  },
});
