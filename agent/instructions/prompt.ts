import { defineDynamic, defineInstructions } from "eve/instructions";
import { CHAT_PROMPT, FACTORY_PROMPT, isSlackSession } from "../lib/prompts.js";

// The orchestrator's system prompt, resolved once per session by channel: Slack sessions get the
// lean chat profile, every other surface gets the full factory prompt. The resolver is total and
// synchronous over compiled constants, and anything unrecognized falls through to the factory
// prompt, so a resolver failure can never leave a session promptless or strip the pipeline from
// intake surfaces.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineInstructions({
        content: isSlackSession(ctx) ? CHAT_PROMPT : FACTORY_PROMPT,
      }),
  },
});
