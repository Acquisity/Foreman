import { defineTool } from "eve/tools";
import { z } from "zod";

const INNGEST_API_BASE = "https://api.inngest.com/v1";

/** Hard cap keeping run/event evidence bounded for the model's context. */
const MAX_RESULT_CHARS = 60_000;

interface InspectInput {
  action: string;
  cursor?: string;
  eventId?: string;
  eventName?: string;
  limit?: number;
  runId?: string;
}

/**
 * Resolves the read-only API path for an action, or an error message when a
 * required identifier is missing.
 */
function resolvePath({
  action,
  eventId,
  runId,
  eventName,
  cursor,
  limit,
}: InspectInput): { path: string } | { error: string } {
  switch (action) {
    case "list_events": {
      const params = new URLSearchParams();
      if (eventName) {
        params.set("name", eventName);
      }
      if (limit) {
        params.set("limit", String(limit));
      }
      if (cursor) {
        params.set("cursor", cursor);
      }
      const query = params.toString();
      return { path: `/events${query ? `?${query}` : ""}` };
    }
    case "get_event":
      return eventId
        ? { path: `/events/${encodeURIComponent(eventId)}` }
        : { error: "eventId is required for get_event." };
    case "get_event_runs":
      return eventId
        ? { path: `/events/${encodeURIComponent(eventId)}/runs` }
        : { error: "eventId is required for get_event_runs." };
    case "get_run":
      return runId
        ? { path: `/runs/${encodeURIComponent(runId)}` }
        : { error: "runId is required for get_run." };
    case "get_run_jobs":
      return runId
        ? { path: `/runs/${encodeURIComponent(runId)}/jobs` }
        : { error: "runId is required for get_run_jobs." };
    default:
      return { error: `Unknown action: ${action}` };
  }
}

/**
 * Read-only Inngest inspection for background-job investigation.
 *
 * @remarks
 * Token-backed authored tool: the signing key stays in the trusted runtime
 * (`INNGEST_SIGNING_KEY`, an encrypted Vercel environment variable) and
 * never reaches the model or a sandbox. Read-only by construction — every
 * action maps to a GET; there is no event sending, cancellation, replay,
 * or retry surface here.
 */
export default defineTool({
  description:
    "Inspect Inngest background jobs, read-only: recent events, a specific event, the runs an event " +
    "triggered, a run's status and output, or a run's step-by-step jobs (including failures and " +
    "retries). Use it while investigating bug tickets involving async processing.",
  async execute(input) {
    const key = process.env.INNGEST_SIGNING_KEY;
    if (!key) {
      return {
        error:
          "INNGEST_SIGNING_KEY is not configured; Inngest inspection is unavailable on this deployment.",
        results: "",
        truncated: false,
      };
    }
    const resolved = resolvePath(input);
    if ("error" in resolved) {
      return { error: resolved.error, results: "", truncated: false };
    }
    try {
      const response = await fetch(`${INNGEST_API_BASE}${resolved.path}`, {
        headers: { Authorization: `Bearer ${key}` },
        method: "GET",
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        return {
          error: `Inngest API request failed (${response.status}): ${detail}`,
          results: "",
          truncated: false,
        };
      }
      let results = await response.text();
      let truncated = false;
      if (results.length > MAX_RESULT_CHARS) {
        results = results.slice(0, MAX_RESULT_CHARS);
        truncated = true;
      }
      return { results, truncated };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Inngest API request failed.",
        results: "",
        truncated: false,
      };
    }
  },
  inputSchema: z.object({
    action: z.enum([
      "list_events",
      "get_event",
      "get_event_runs",
      "get_run",
      "get_run_jobs",
    ]),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous list_events response"),
    eventId: z
      .string()
      .optional()
      .describe("Event ID (required for get_event / get_event_runs)"),
    eventName: z
      .string()
      .optional()
      .describe("Filter list_events to one event name"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Page size for list_events (max 100)"),
    runId: z
      .string()
      .optional()
      .describe("Run ID (required for get_run / get_run_jobs)"),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    results: z.string(),
    truncated: z.boolean(),
  }),
});
