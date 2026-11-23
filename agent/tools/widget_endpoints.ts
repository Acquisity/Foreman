import { defineDynamic } from "eve/tools";
import { endpointToolSet } from "#lib/widget-endpoint-tools.js";

/**
 * One tool per Acquisity support endpoint the context route listed for this
 * session's user (ENG-20296), built from the generated manifest. A feature
 * that is off for the workspace never shows up, and the endpoint refuses it
 * anyway.
 */
export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      endpointToolSet(ctx.session.auth.initiator),
  },
});
