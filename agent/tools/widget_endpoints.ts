import { defineDynamic, defineTool } from "eve/tools";
import {
  callWidgetEndpoint,
  offeredEndpointTools,
} from "#lib/widget-endpoint-tools.js";
import { isWidgetSupport, widgetContext } from "#lib/widget-scope.js";

/**
 * One tool per Acquisity support endpoint the context route listed for this
 * session's user (ENG-20296), built from the generated manifest. A feature
 * that is off for the workspace never shows up, and the endpoint refuses it
 * anyway.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      const offered = offeredEndpointTools(
        widgetContext(ctx.session.auth.initiator)?.endpoints
      );
      if (offered.length === 0) {
        return null;
      }
      return Object.fromEntries(
        offered.map((entry) => [
          entry.name,
          defineTool({
            approval: (toolCtx) =>
              isWidgetSupport(toolCtx.session.auth.initiator)
                ? "not-applicable"
                : {
                    reason: "Support widget investigations only.",
                    type: "denied",
                  },
            description: entry.description,
            execute: (input: Record<string, unknown>, toolCtx) =>
              callWidgetEndpoint(
                toolCtx,
                { name: entry.name, path: entry.path },
                input
              ),
            inputSchema: entry.inputSchema,
          }),
        ])
      );
    },
  },
});
