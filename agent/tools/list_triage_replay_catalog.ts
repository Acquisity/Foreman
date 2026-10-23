import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { withReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { replayCatalog } from "#lib/triage-replay/store.js";

export const tool = defineTool({
  approval: (ctx) =>
    replaySessionOf(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Triage replay sessions only.", type: "denied" },
  description:
    "Replay only: the Linear connection is closed in a replay, so read the team's lists for Stage 5 here instead. Returns the ENG product projects that were open when the ticket was filed and the Root Cause label names that existed then; pass them to decide_triage as projects and rootCauseLabels.",
  async execute(_input, ctx) {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session) {
      throw new Error("Triage replay session required.");
    }
    return await withReplayState(session.runId, session.caseId, (state) => {
      const catalog = replayCatalog(state);
      state.inputs.push({
        availableAt: state.case.createdAt,
        content: JSON.stringify(catalog),
        provenance: "seeded",
        source: "list_triage_replay_catalog",
      });
      return catalog;
    });
  },
  inputSchema: z.strictObject({}),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      replaySessionOf(ctx.session.auth.initiator) ? tool : null,
  },
});
