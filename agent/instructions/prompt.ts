import { defineDynamic, defineInstructions } from "eve/instructions";
import { selectPrompt } from "../lib/prompts.js";

// The agent's system prompt, resolved by caller: unattended factory runs (an issue labeled
// `factory`, red CI on a factory PR) run under the autonomous principal and get the full
// factory prompt inline; every interactive session gets the general profile, which reaches
// the same pipeline through the factory-pipeline skill. The selection lives in `selectPrompt`
// (agent/lib/prompts.ts), a total pure function over the caller's principal. Resolved at turn
// scope rather than session scope because a session-scope result is written once at session
// start, and sessions that predate a deploy never re-fire session.started: with no static
// instructions compiled, those sessions would run promptless forever. Re-resolving each turn
// keeps them covered, and since the caller never changes within a session the content is
// identical every turn, so the provider prompt cache stays warm.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: selectPrompt(ctx.session.auth.current?.principalId),
      }),
  },
});
