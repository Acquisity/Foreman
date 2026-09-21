import { defineAgent, defineDynamic } from "eve";
import { isFinInvestigation } from "./lib/fin-investigation-auth.js";
import { finInvestigationModel } from "./lib/fin-investigation-model.js";
import { gatewayRouting, resolveModel } from "./lib/models.js";
import { ticketLinkedModel } from "./lib/ticket-link-model.js";
import { widgetInvestigationModel } from "./lib/widget-investigation-model.js";
import { isWidgetSupport } from "./lib/widget-scope.js";

function investigationModel(
  auth: Parameters<typeof isWidgetSupport>[0],
  id: string,
  sessionId?: string
) {
  if (isWidgetSupport(auth)) {
    return widgetInvestigationModel(id, sessionId);
  }
  if (isFinInvestigation(auth)) {
    return finInvestigationModel(id);
  }
  return ticketLinkedModel(id);
}

// Root agent runtime configuration: the model for Foreman, Acquisity's
// general-purpose agent; the rest of the surface (channels, connections,
// extensions, tools, skills, subagents) is discovered from the filesystem
// under agent/. History compacts at 75% of the context window.
//
// Both per-session token caps are disabled. The input axis would otherwise
// default to 40M tokens, and cached prompt re-reads count as input on every
// model call, so a long Slack thread could cross it and park on eve's
// Approve/Stop budget card, which Slack cannot answer. Output has no cap
// either: a run is billed per session, not per line of output, and the cap
// was blocking legitimate implementation runs.
//
// Wrapped model instances resolve at step start: Eve cannot serialize provider
// objects into durable session/turn selections. resolveModel retains live overrides.
// The selection also carries the gateway routing for a DeepSeek id (see gatewayRouting).
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: { maxInputTokensPerSession: false },
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const id = await resolveModel("orchestrator");
        return {
          model: investigationModel(
            ctx.session.auth.initiator,
            id,
            ctx.session.id
          ),
          modelOptions: gatewayRouting(id),
        };
      },
    },
  }),
});
