import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { readReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { replayIssueView } from "#lib/triage-replay/views.js";

export const tool = defineTool({
  approval: (ctx) =>
    replaySessionOf(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Triage replay sessions only.", type: "denied" },
  description:
    "Replay only: the Linear connection is closed in a replay, so read an issue here instead. For the ticket being triaged it returns the report as first filed, its attachment kinds, the comments and routing this replay wrote, and its current fields. For a related issue it returns that issue as it was when the ticket was filed, with unknown where history can't say. found false means the replay holds no such issue.",
  async execute({ issue }, ctx) {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session) {
      throw new Error("Triage replay session required.");
    }
    const view = replayIssueView(
      await readReplayState(session.runId, session.caseKey),
      issue
    );
    return view ? { found: true as const, ...view } : { found: false as const };
  },
  inputSchema: z.strictObject({
    issue: z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      replaySessionOf(ctx.session.auth.initiator) ? tool : null,
  },
});
