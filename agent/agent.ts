import { defineAgent, defineDynamic } from "eve";
import {
  type AgentModelSlot,
  fastCallOptions,
  gatewayRouting,
  resolveModel,
} from "./lib/models.js";
import { ticketLinkedModel } from "./lib/ticket-link-model.js";
import { isTriageIntake } from "./lib/trust.js";
import { widgetInvestigationModel } from "./lib/widget-investigation-model.js";
import { isWidgetSupport } from "./lib/widget-scope.js";

function investigationModel(
  auth: Parameters<typeof isWidgetSupport>[0],
  id: string,
  sessionId?: string,
  stepsId?: string
) {
  if (isWidgetSupport(auth)) {
    return widgetInvestigationModel(id, sessionId, stepsId);
  }
  return ticketLinkedModel(id);
}

/** The root's model slot: widget sessions, then triage intake (ENG-15226), then everyone else. */
export const rootModelSlot = (
  auth: Parameters<typeof isWidgetSupport>[0]
): AgentModelSlot => {
  if (isWidgetSupport(auth)) {
    return "widget";
  }
  return isTriageIntake(auth ?? null) ? "triage" : "orchestrator";
};

// Root agent runtime configuration: the model for Foreman, Acquisity's
// general-purpose agent; the rest of the surface (channels, connections,
// extensions, tools, skills, subagents) is discovered from the filesystem
// under agent/. History compacts at 75% of the context window.
//
// sessionUsage returns false, so no session ever reaches a usage window.
// eve's default asks for approval after 40M new input tokens per window, and a
// long Slack thread could cross it and park on eve's Continue/Stop card, which
// Slack cannot answer. Output stays uncapped too: a run is billed per session,
// not per line of output, and a cap blocked legitimate implementation runs.
// Critic, vision and native delegates author no limit and use this one.
//
// Wrapped model instances resolve at step start: Eve cannot serialize provider
// objects into durable session/turn selections. resolveModel retains live overrides.
// The selection also carries the gateway routing for a DeepSeek id (see gatewayRouting).
export default defineAgent({
  compaction: { thresholdPercent: 0.75 },
  limits: { sessionUsage: () => false },
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const widget = isWidgetSupport(ctx.session.auth.initiator);
        const id = await resolveModel(
          rootModelSlot(ctx.session.auth.initiator)
        );
        return {
          model: investigationModel(
            ctx.session.auth.initiator,
            id,
            ctx.session.id,
            widget ? await resolveModel("widgetSteps") : undefined
          ),
          // Jev decides each widget step, so the widget model only acts: on its
          // default reasoning each step ran past the 15s model-call timeout.
          modelOptions: widget ? fastCallOptions(id) : gatewayRouting(id),
        };
      },
    },
  }),
});
