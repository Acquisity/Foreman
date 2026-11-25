import { z } from "zod";
import { DEFAULT_PARTNER_ID } from "./acquisity-constants.js";
import { acquisityOrigin, readContextBody } from "./acquisity-origin.js";
import {
  featuresOffNames,
  type HelpCenterView,
  helpCenterViewSchema,
} from "./help-center.js";
import { parseAvailableEndpoints } from "./widget-endpoint-schema.js";
import { areasOffFor } from "./widget-endpoint-tools.js";
import { isLiveActive, liveContext } from "./widget-live-policy.js";
import {
  ORGANIZATION_NAME_MAX,
  ORGANIZATION_SLUG,
  officeHoursSchema,
  type WidgetContext,
  widgetContextSchema,
} from "./widget-scope.js";

const FEATURE_FLAG = /^[a-z][a-z0-9_]{0,99}$/u;
const featureName = (flag: string) => flag.replaceAll("_", " ");

/** The app's verified workspace payload; Intercom's app id is irrelevant to the widget and ignored. */
const appContextSchema = z.looseObject({
  endpoints: z.unknown().optional().transform(parseAvailableEndpoints),
  // The endpoint features that are off (raw flags such as ai_website_creator),
  // listed beside the endpoints. Malformed reads as none.
  featuresOff: z
    .array(z.string().regex(FEATURE_FLAG))
    .max(200)
    .optional()
    .catch(undefined),
  // Absent or malformed: the docs are read signed out and the guide is not narrowed.
  helpCenter: helpCenterViewSchema.optional().catch(undefined),
  // Any problem with it reads as absent: support counts as open, as before.
  officeHours: officeHoursSchema.optional().catch(undefined),
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(ORGANIZATION_NAME_MAX),
  organizationSlug: z.string().regex(ORGANIZATION_SLUG),
  partnerId: z.literal(DEFAULT_PARTNER_ID),
  role: z.enum(["owner", "admin", "member", "client"]),
  timeline: z.record(z.string(), z.unknown()).optional().catch(undefined),
  userId: z.uuid(),
  verifiedAt: z.iso.datetime(),
});

/** Both lists of features that are off, and the endpoint areas they close. */
const offFeatures = (
  endpointFlags: readonly string[] | undefined,
  helpCenter: HelpCenterView | undefined
) => {
  const featuresOff = [
    ...new Set([
      ...(endpointFlags ?? []).map(featureName),
      ...featuresOffNames(helpCenter),
    ]),
  ];
  const areasOff = areasOffFor(endpointFlags);
  return {
    ...(featuresOff.length > 0 ? { featuresOff } : {}),
    ...(areasOff.length > 0 ? { areasOff } : {}),
  };
};

// The endpoint list adds about 2 KB for eleven endpoints to the 4 KB the rest needs.
const CONTEXT_MAX_BYTES = 16 * 1024;
const TIMELINE_MAX_BYTES = 32 * 1024 + CONTEXT_MAX_BYTES;

const inputSchema = z.object({
  conversationId: z.uuid(),
  organizationId: z.uuid(),
  userToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_.-]+$/),
});

/** Verify the widget user's workspace with the Acquisity app; the conversation id is caller-owned, the scope is not. */
export async function verifyWidgetContext(
  input: {
    conversationId: string;
    organizationId: string;
    userToken: string;
    signal?: AbortSignal;
    // The token belongs to a support teammate, not the customer. The app then
    // checks the teammate and returns the conversation's customer as the scope.
    staff?: boolean;
    timeline?: boolean;
    onTimeline?: (timeline: Record<string, unknown>) => void;
  },
  request: typeof fetch = fetch
): Promise<WidgetContext> {
  const parsed = inputSchema.parse(input);
  if (isLiveActive()) {
    return liveContext({ ...parsed, staff: input.staff });
  }
  const origin = acquisityOrigin();
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(50_000)])
    : AbortSignal.timeout(50_000);
  const response = await request(`${origin}/api/internal/foreman/context`, {
    body: JSON.stringify({
      organizationId: parsed.organizationId,
      // The customer lane names its conversation too, so a preview admin
      // override resolves from this exact chat, never the admin's newest one.
      ...(input.staff
        ? { conversationId: parsed.conversationId }
        : { widgetConversationId: parsed.conversationId }),
    }),
    headers: {
      authorization: `Bearer ${parsed.userToken}`,
      "content-type": "application/json",
      "x-partner-id": DEFAULT_PARTNER_ID,
      ...(input.timeline ? { "x-foreman-timeline": "1" } : {}),
    },
    method: "POST",
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    response.body?.cancel().catch(() => undefined);
    throw new Error("Workspace support access could not be verified.");
  }
  const verified = appContextSchema.parse(
    await readContextBody(
      response,
      signal,
      input.timeline ? TIMELINE_MAX_BYTES : CONTEXT_MAX_BYTES
    )
  );
  if (verified.organizationId !== parsed.organizationId) {
    throw new Error("The verified workspace does not match this conversation.");
  }
  if (input.timeline && verified.timeline) {
    input.onTimeline?.(verified.timeline);
  }
  return Object.freeze(
    widgetContextSchema.parse({
      conversationId: parsed.conversationId,
      ...(verified.endpoints ? { endpoints: verified.endpoints } : {}),
      ...offFeatures(verified.featuresOff, verified.helpCenter),
      organizationId: verified.organizationId,
      organizationName: verified.organizationName,
      organizationSlug: verified.organizationSlug,
      ...(verified.helpCenter ? { helpCenter: verified.helpCenter } : {}),
      ...(verified.officeHours ? { officeHours: verified.officeHours } : {}),
      partnerId: verified.partnerId,
      role: verified.role,
      source: input.staff ? "inbox" : "widget",
      userId: verified.userId,
      verifiedAt: verified.verifiedAt,
    })
  );
}
