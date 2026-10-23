import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { withReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { replayIssueView } from "#lib/triage-replay/store.js";

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
    return await withReplayState(session.runId, session.caseId, (state) => {
      const view = replayIssueView(state, issue);
      if (!view) {
        return { found: false as const };
      }
      for (const [provenance, part] of [
        ["seeded", view.seeded],
        ["generated", view.generated],
      ] as const) {
        if (part !== null) {
          state.inputs.push({
            availableAt: provenance === "seeded" ? state.case.createdAt : null,
            content: JSON.stringify(part),
            provenance,
            source: "read_triage_replay_issue",
          });
        }
      }
      return {
        found: true as const,
        issue: view.seeded,
        replay: view.generated,
      };
    });
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
