import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { withReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { addReplayComment } from "#lib/triage-replay/store.js";

export const tool = defineTool({
  approval: (ctx) =>
    replaySessionOf(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Triage replay sessions only.", type: "denied" },
  description:
    "Replay only: the Linear connection is closed in a replay, so post a comment on an issue here instead. The comment stays in this replay and reaches nobody.",
  async execute({ body, issue }, ctx) {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session) {
      throw new Error("Triage replay session required.");
    }
    const posted = await withReplayState(
      session.runId,
      session.caseId,
      (state) => addReplayComment(state, issue, body)
    );
    return posted
      ? { posted: true as const }
      : { error: `No issue ${issue} in this replay.`, posted: false as const };
  },
  inputSchema: z.strictObject({
    body: z.string().trim().min(1).max(20_000),
    issue: z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      replaySessionOf(ctx.session.auth.initiator) ? tool : null,
  },
});
