import type { ProviderContext } from "./executor/dispatch.js";
import { WIDGET_TOOLKIT } from "./executor/endpoint.js";
import { WIDGET_PATHS } from "./widget-catalog.js";
import { isWidgetSupport, widgetContext } from "./widget-scope.js";

const paths: ReadonlySet<string> = new Set(WIDGET_PATHS);
/** The lane's one write. dispatch.ts checks its input against the verified scope before this policy is reached. */
export const WIDGET_TICKET_PATH = "linear.org.workspaceLinear.save_issue";

export function assertWidgetPath(path: string) {
  if (!paths.has(path)) {
    throw new Error("This operation is outside the support widget toolkit.");
  }
}

/**
 * The reads widget_read_recording makes of the customer's own screen recording.
 * They stay off WIDGET_PATHS, so widget_provider cannot reach Jam at all, and
 * the policy below allows them only for the recording bound to the session.
 */
export const RECORDING_READS = {
  consoleErrors: {
    input: { limit: 30, logLevel: ["error", "warn"] },
    path: "jam.user.personalJam.getconsolelogs",
  },
  details: { input: {}, path: "jam.user.personalJam.getdetails" },
  failedRequests: {
    input: { limit: 20, statusCode: ["4xx", "5xx"] },
    path: "jam.user.personalJam.getnetworkrequests",
  },
  steps: { input: { limit: 60 }, path: "jam.user.personalJam.getuserevents" },
  transcript: { input: {}, path: "jam.user.personalJam.getvideotranscript" },
} as const;
const recordingPaths: ReadonlySet<string> = new Set(
  Object.values(RECORDING_READS).map(({ path }) => path)
);

/** Every catalog path is a read and the ticket write is deduplicated by its tool, so the policy never reserves a write. */
export function widgetOperationPolicy(ctx: ProviderContext) {
  if (!isWidgetSupport(ctx.session?.auth.initiator)) {
    return null;
  }
  return {
    assert: (path: string, input?: Record<string, unknown>) => {
      if (recordingPaths.has(path)) {
        const recordingId = widgetContext(
          ctx.session?.auth.initiator
        )?.recordingId;
        if (!recordingId || input?.jamId !== recordingId) {
          throw new Error("Only this chat's own screen recording can be read.");
        }
        return;
      }
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
