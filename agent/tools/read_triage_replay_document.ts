import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { withReplayState } from "#lib/triage-replay/backend.js";
import { replaySessionOf } from "#lib/triage-replay/mode.js";
import { replayDocumentText } from "#lib/triage-replay/store.js";

/**
 * Triage replay only (ENG-16049): reads an investigation document this replay
 * saved, by id, with the version pin the critic echoes. Outside a replay the
 * tool doesn't exist. It returns only what the replay itself wrote.
 */
export const tool = defineTool({
  approval: (ctx) =>
    replaySessionOf(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Triage replay sessions only.", type: "denied" },
  description:
    "Replay only: read the Triage investigation document saved in this replay, by documentId. Returns its content and updatedAt, the version the critic reviews.",
  async execute({ documentId }, ctx) {
    const session = replaySessionOf(ctx.session.auth.initiator);
    if (!session) {
      throw new Error("Triage replay session required.");
    }
    const doc = await withReplayState(session.runId, session.caseId, (state) =>
      replayDocumentText(state, documentId)
    );
    return doc ? { found: true as const, ...doc } : { found: false as const };
  },
  inputSchema: z.strictObject({ documentId: z.string().min(1).max(200) }),
  outputSchema: z.object({
    content: z.string().optional(),
    found: z.boolean(),
    updatedAt: z.string().optional(),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      replaySessionOf(ctx.session.auth.initiator) ? tool : null,
  },
});
