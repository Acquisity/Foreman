import { defineDynamic, defineTool } from "eve/tools";
import { readFinEvidence } from "#lib/executor/dispatch.js";
import { finEvidenceInput, finEvidenceOutput } from "#lib/fin-evidence.js";
import { isFinInvestigation } from "#lib/fin-investigation-auth.js";

const tool = defineTool({
  description:
    "Read saved outreach evidence only in this chat's verified workspace. Use campaigns to list up to 50 visible campaigns, with nextAfter for the next page; campaign for one local campaign UUID with up to 30 recent daily metrics and 20 status changes; connections for saved provider status. Returned state is from the product database, not a live provider check. Missing metrics do not mean zero sends. Unavailable is not empty. No SQL, workspace, provider account or arbitrary field selector is accepted.",
  execute: async (input, ctx) => readFinEvidence(ctx, input),
  inputSchema: finEvidenceInput,
  outputSchema: finEvidenceOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isFinInvestigation(ctx.session.auth.initiator) ? tool : null,
  },
});
