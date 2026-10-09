import { z } from "zod";
import { creditHistoryWindowSchema } from "./billing-account.js";

/** Live investigations require the local Workflow world and local file storage. */
export function assertLiveAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (env.WIDGET_LIVE === "1" && env.VERCEL_ENV !== undefined) {
    throw new Error(
      "Widget live re-runs are local-only; VERCEL_ENV must be absent."
    );
  }
}

export function liveServerUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Widget live server must be an HTTP loopback origin.");
  }
  return url.origin;
}

export const LIVE_PROTOCOL = "widget-live-local-v1";

/** No recorded scope or message is transmitted before this data-free probe succeeds. */
export async function verifyLiveServer(
  server: string,
  secret: string,
  request = fetch
) {
  const response = await request(
    `${liveServerUrl(server)}/internal/widget/live`,
    {
      headers: { "x-acquisity-service-secret": secret },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    }
  );
  if (!response.ok || (await response.text()) !== LIVE_PROTOCOL) {
    throw new Error(
      "The loopback server is not running the local live harness."
    );
  }
}

const datedInput = z.object({
  campaignId: z.uuid().nullish(),
  creditWindow: creditHistoryWindowSchema.optional(),
  endDate: z.iso.date().nullish(),
  startDate: z.iso.date().nullish(),
});

export function hasMovingWindow(tool: string, input: unknown) {
  if (tool !== "widget_billing_summary" && tool !== "widget_outreach_health") {
    return false;
  }
  const parsed = datedInput.parse(input);
  return tool === "widget_billing_summary"
    ? !parsed.creditWindow
    : !(parsed.startDate && parsed.endDate);
}

/**
 * Preserve explicit windows. Otherwise billing reads the original UTC day
 * [midnight, next midnight); campaign metrics read seven calendar days ending
 * on that day, inclusive. Campaign listing has no date filter in today's API.
 */
export function pinLiveInput(
  tool: string,
  input: unknown,
  sentAt: string | undefined
): unknown {
  if (!hasMovingWindow(tool, input)) {
    return input;
  }
  const date = z.iso.datetime().parse(sentAt);
  const day = date.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  const parsed = datedInput.parse(input);
  if (tool === "widget_billing_summary") {
    return {
      ...(input as object),
      creditWindow: {
        from: new Date(midnight).toISOString(),
        to: new Date(midnight + 86_400_000).toISOString(),
      },
    };
  }
  if (parsed.startDate || parsed.endDate) {
    throw new Error("A historical campaign window must include both dates.");
  }
  return parsed.campaignId
    ? {
        ...(input as object),
        endDate: day,
        startDate: new Date(midnight - 6 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      }
    : input;
}

/** The authored tool boundary calls this; flag-free customer reads keep their exact inputs. */
export function liveToolInput<T>(
  tool: string,
  input: T,
  sentAt: string | undefined
): T {
  assertLiveAllowed();
  return process.env.WIDGET_LIVE === "1"
    ? (pinLiveInput(tool, input, sentAt) as T)
    : input;
}
