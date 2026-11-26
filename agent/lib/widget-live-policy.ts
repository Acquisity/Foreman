import { z } from "zod";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

/** Live investigations require the local Workflow world and local file storage. */
export function assertLiveAllowed(env: NodeJS.ProcessEnv = process.env) {
  if (env.WIDGET_LIVE === "1" && env.VERCEL_ENV !== undefined) {
    throw new Error(
      "Widget live re-runs are local-only; VERCEL_ENV must be absent."
    );
  }
}
// The widget channel imports this module, so a deployment with the flag fails at boot.
assertLiveAllowed();

/**
 * Live re-run (ENG-15026, `pnpm widget:live`): with WIDGET_LIVE=1 every widget read is live,
 * widget_file_ticket files nothing, and identity is the recorded production scope the
 * harness sends as the bearer token. Local-only.
 */
export const isLiveActive = () => {
  assertLiveAllowed();
  return process.env.WIDGET_LIVE === "1";
};

/**
 * The result is a simulated filed ticket, so a correct ticket reaches the composer's
 * "passed to the team" reply as it would in production (ENG-15044 round 15: with
 * `filed: false` no live reply could say so). ENG-0 is never a real issue.
 */
export const LIVE_TICKET = Object.freeze({
  identifier: "ENG-0",
  live: "simulated: nothing was filed",
  simulated: true,
  url: "https://linear.app/acquisity/issue/ENG-0/simulated-live-ticket",
});

const liveIdentitySchema = z.strictObject({
  scope: widgetContextSchema,
  sentAt: z.iso.datetime(),
});

/**
 * A live re-run's scope: the production run's recorded scope, sent base64url-encoded as the
 * bearer token, on the request's own conversation and always as a team-only inbox run. A
 * recorded `recordingId` stays, as production verified it, so the recording stays readable.
 */
export function liveContext(input: {
  conversationId: string;
  organizationId: string;
  staff?: boolean;
  userToken: string;
}): WidgetContext {
  const { scope: recorded, sentAt } = liveIdentitySchema.parse(
    JSON.parse(Buffer.from(input.userToken, "base64url").toString("utf8"))
  );
  if (!input.staff || input.organizationId !== recorded.organizationId) {
    throw new Error(
      "Live re-runs require the recorded workspace and staff path."
    );
  }
  return Object.freeze(
    widgetContextSchema.parse({
      ...recorded,
      conversationId: input.conversationId,
      liveAsOf: sentAt,
      source: "inbox",
    })
  );
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

export function hasMovingWindow(tool: string, input: unknown) {
  // The billing endpoint's creditWindow counts days back from now, so every
  // re-read of it covers a different window.
  if (tool === "widget_billing") {
    return true;
  }
  if (tool !== "widget_campaigns") {
    return false;
  }
  const { endDate, startDate } = (input ?? {}) as {
    endDate?: unknown;
    startDate?: unknown;
  };
  return !(startDate && endDate);
}
