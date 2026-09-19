import type { ProviderContext } from "./executor/dispatch.js";
import { WIDGET_TOOLKIT } from "./executor/endpoint.js";
import { WIDGET_PATHS } from "./widget-catalog.js";
import { isWidgetSupport } from "./widget-scope.js";

const paths: ReadonlySet<string> = new Set(WIDGET_PATHS);
/** The lane's one write. dispatch.ts checks its input against the verified scope before this policy is reached. */
export const WIDGET_TICKET_PATH = "linear.org.workspaceLinear.save_issue";

export function assertWidgetPath(path: string) {
  if (!paths.has(path)) {
    throw new Error("This operation is outside the support widget toolkit.");
  }
}

/** Every catalog path is a read and the ticket write is deduplicated by its tool, so the policy never reserves a write. */
export function widgetOperationPolicy(ctx: ProviderContext) {
  if (!isWidgetSupport(ctx.session?.auth.initiator)) {
    return null;
  }
  return {
    assert: (path: string) => {
      if (path !== WIDGET_TICKET_PATH) {
        assertWidgetPath(path);
      }
    },
    authorize: () => Promise.resolve("initial"),
    complete: () => Promise.resolve(),
    describe: assertWidgetPath,
    record: () => Promise.resolve(),
    reserve: () => Promise.resolve({ fresh: true as const, result: null }),
    toolkit: WIDGET_TOOLKIT as typeof WIDGET_TOOLKIT,
    writeKey: () => null,
  };
}
