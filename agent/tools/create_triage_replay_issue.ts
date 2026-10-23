import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { withReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { createReplayIssue } from "#lib/triage-replay/views.js";

const name = z.string().trim().min(1).max(120);

export const tool = defineTool({
  approval: (ctx) =>
    replaySessionOf(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Triage replay sessions only.", type: "denied" },
  description:
    "Replay only: the Linear connection is closed in a replay, so create an ENG issue, such as a new master, here instead. Returns its identifier, which route_ticket and read_triage_replay_issue accept. The issue stays in this replay.",
  async execute(input, ctx) {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session) {
      throw new Error("Triage replay session required.");
    }
    const identifier = await withReplayState(
      session.runId,
      session.caseId,
      (state) => createReplayIssue(state, input)
    );
    return { created: true as const, identifier };
  },
  inputSchema: z.strictObject({
    assignee: name.optional().describe("User name or email."),
    description: z.string().trim().min(1).max(20_000),
    labels: z.array(name).max(10).optional(),
    parent: z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    project: name.optional(),
    title: z.string().trim().min(1).max(300),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      replaySessionOf(ctx.session.auth.initiator) ? tool : null,
  },
});
