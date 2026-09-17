import type { ProviderContext } from "./executor/dispatch.js";
import { WIDGET_TOOLKIT } from "./executor/endpoint.js";
import { WIDGET_PATHS } from "./widget-catalog.js";
import { isWidgetSupport } from "./widget-scope.js";

const paths: ReadonlySet<string> = new Set(WIDGET_PATHS);

export function assertWidgetPath(path: string) {
  if (!paths.has(path)) {
    throw new Error("This operation is outside the support widget toolkit.");
  }
}

/** Every selected widget path is a read, so the policy carries the toolkit and never reserves a write. */
export function widgetOperationPolicy(ctx: ProviderContext) {
  if (!isWidgetSupport(ctx.session?.auth.initiator)) {
    return null;
  }
  return {
    assert: (path: string) => assertWidgetPath(path),
    authorize: () => Promise.resolve("initial"),
    complete: () => Promise.resolve(),
    describe: assertWidgetPath,
    record: () => Promise.resolve(),
    reserve: () => Promise.resolve({ fresh: true as const, result: null }),
    toolkit: WIDGET_TOOLKIT as typeof WIDGET_TOOLKIT,
    writeKey: () => null,
  };
}
