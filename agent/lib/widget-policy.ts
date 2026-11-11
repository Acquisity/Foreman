import { z } from "zod";
import type { ProviderContext } from "./executor/dispatch.js";
import { WIDGET_TOOLKIT } from "./executor/endpoint.js";
import { WIDGET_PATHS } from "./widget-catalog.js";
import { isWidgetSupport, widgetContext } from "./widget-scope.js";

const paths: ReadonlySet<string> = new Set(WIDGET_PATHS);
/** The lane's one write. dispatch.ts checks its input against the verified scope before this policy is reached. */
export const WIDGET_TICKET_PATH = "linear-foreman.save_issue";

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
    path: "jam-foreman.getConsoleLogs",
  },
  details: { input: {}, path: "jam-foreman.getDetails" },
  failedRequests: {
    input: { limit: 20, statusCode: ["4xx", "5xx"] },
    path: "jam-foreman.getNetworkRequests",
  },
  steps: { input: { limit: 60 }, path: "jam-foreman.getUserEvents" },
  transcript: { input: {}, path: "jam-foreman.getVideoTranscript" },
} as const;
const recordingPaths: ReadonlySet<string> = new Set(
  Object.values(RECORDING_READS).map(({ path }) => path)
);

/**
 * The bug report's one PostHog read (ENG-18429). Like the recording reads it
 * stays off WIDGET_PATHS, and the policy allows only the query below for the
 * verified user and the report time the bug report stamped on the session.
 */
export const POSTHOG_READ = { path: "posthog-widget.execute-sql" } as const;
const POSTHOG_WINDOW_MS = 30 * 60 * 1000;

/** The reporting user's page views and error toasts in the 30 minutes before the report. */
export function posthogQuery(userId: string, reportedAt: Date): string {
  const id = z.uuid().parse(userId);
  const from = new Date(reportedAt.getTime() - POSTHOG_WINDOW_MS).toISOString();
  return [
    // The path is free text, so it comes last and the table parser keeps any pipe in it.
    "SELECT timestamp, event, replaceAll(toString(properties.errorCode), '|', ' ') AS errorCode, properties.$pathname",
    "FROM events",
    `WHERE distinct_id = '${id}'`,
    "AND event IN ('$pageview', 'crm.error_toast_shown')",
    `AND timestamp >= toDateTime('${from}')`,
    `AND timestamp <= toDateTime('${reportedAt.toISOString()}')`,
    "ORDER BY timestamp DESC",
    "LIMIT 8",
  ].join(" ");
}

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
      if (path === POSTHOG_READ.path) {
        const scope = widgetContext(ctx.session?.auth.initiator);
        if (
          !(scope?.bugReportedAt && input) ||
          Object.keys(input).length !== 1 ||
          input.query !==
            posthogQuery(scope.userId, new Date(scope.bugReportedAt))
        ) {
          throw new Error("Only this customer's own activity can be read.");
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
