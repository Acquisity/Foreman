import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { DEFAULT_PARTNER_ID } from "./acquisity-constants.js";
import { featuresOffNames, helpCenterViewSchema } from "./help-center.js";
import { stampUnattended } from "./trust.js";
import {
  availableEndpointSchema,
  parseAvailableEndpoints,
} from "./widget-endpoint-schema.js";

export const WIDGET_SUPPORT_ISSUER = "foreman:widget-support";

// e.g. "Monday–Friday: 9:00 AM–5:00 PM", "Eastern Time", "Closed all day".
const scheduleText = z.string().regex(/^[\p{L}\p{N}\p{Pd} ,:./()+]{1,200}$/u);
// An admin's own name for a closure, such as "New Year's Day".
const CLOSURE_LABEL = /^[^\p{Cc}<>{}]{1,100}$/u;

/**
 * Acquisity's support office hours as its context route computes them per
 * request (ENG-15262). Absent means always open, as before the app sent it.
 */
export const officeHoursSchema = z.strictObject({
  customerTimeZone: z.string().min(1).max(100),
  enabled: z.boolean(),
  // The team's published schedule, in its own zone, as customer-facing text.
  // Optional, since Foreman deploys apart from the app: a malformed one reads
  // as absent and the rest of the office hours stand. See officeSchedule.
  hoursText: z.array(scheduleText).max(7).optional().catch(undefined),
  nextOpenAt: z.iso.datetime({ offset: true }).nullable(),
  // Customer-facing text Foreman repeats verbatim, e.g. "Monday, Oct 19 at 9:00 AM EDT".
  nextOpenText: z
    .string()
    .regex(/^[\p{L}\p{N} ,:./()+-]{1,80}$/u)
    .nullable(),
  open: z.boolean(),
  replyTimeMinutes: z.int().min(1).max(10_080),
  replyTimeText: z.string().min(1).max(80),
  showReplyTime: z.boolean(),
  timeZone: z.string().min(1).max(100),
  timeZoneName: scheduleText.optional().catch(undefined),
  upcomingClosures: z
    .array(
      z.strictObject({
        // A real calendar date: Zod rejects 2026-02-30 as well as a bad shape.
        date: z.iso.date(),
        hours: scheduleText,
        label: z.string().regex(CLOSURE_LABEL).nullable(),
      })
    )
    .max(20)
    .optional()
    .catch(undefined),
});
export type OfficeHours = z.infer<typeof officeHoursSchema>;

export const ORGANIZATION_NAME_MAX = 500;
export const ORGANIZATION_SLUG_MAX = 200;
export const ORGANIZATION_SLUG = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,${ORGANIZATION_SLUG_MAX - 1}}$`
);

const shape = {
  // When the customer sent an "I found a bug" report. Only the bug report's
  // evidence lookup sets it, and the policy reads PostHog and Inngest only for it.
  bugReportedAt: z.iso.datetime().optional(),
  conversationId: z.uuid(),
  // The support endpoints the context route lists for the asking user
  // (ENG-20296). Absent means the list was not given or could not be read.
  endpoints: z.array(availableEndpointSchema).max(50).optional(),
  // The names of the features turned off for the workspace, taken from
  // helpCenter when the session is stamped (ENG-20514), so the investigator
  // can say a feature is off instead of that it could not be read.
  featuresOff: z.array(z.string().min(1).max(300)).max(200).optional(),
  // The customer's Help Centre view for the knowledge base lane: never stamped
  // on the session, and dropped from the stored run.
  helpCenter: helpCenterViewSchema.optional(),
  // Only the local live harness stamps the original conversation date.
  liveAsOf: z.iso.datetime().optional(),
  // Kept on the run so its finish reads the hours the message was sent in.
  // Never stamped on the session: auth attributes hold strings only.
  officeHours: officeHoursSchema.optional(),
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(ORGANIZATION_NAME_MAX),
  organizationSlug: z.string().regex(ORGANIZATION_SLUG),
  partnerId: z.literal(DEFAULT_PARTNER_ID),
  // The Jam id of the screen recording this turn follows up on. Acquisity sets
  // it only after checking the recording's signed conversation reference.
  recordingId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  role: z.enum(["owner", "admin", "member", "client"]),
  // "inbox" marks a run a teammate started from the support inbox: its result is
  // team-only and it never becomes context for a customer reply.
  source: z.enum(["widget", "inbox"]),
  userId: z.uuid(),
  verifiedAt: z.iso.datetime(),
};

/** The complete server-verified scope stamped on an in-app support investigation. */
export const widgetContextSchema = z.strictObject(shape);
/**
 * Session attributes also carry trust stamps, so reading the scope back strips
 * unknown keys. They hold strings only, so the endpoint list is stamped as JSON.
 */
export const stampedWidgetAttributes = z.object({
  ...shape,
  endpoints: z
    .string()
    .optional()
    .transform((text) =>
      text === undefined ? undefined : parseAvailableEndpoints(JSON.parse(text))
    ),
  featuresOff: z
    .string()
    .optional()
    .transform((text) =>
      text === undefined ? undefined : shape.featuresOff.parse(JSON.parse(text))
    ),
});

export type WidgetContext = Readonly<z.infer<typeof widgetContextSchema>>;

/** The issuer is the lane boundary; malformed attributes stay in the lane and fail closed. */
export function isWidgetSupport(
  auth: SessionAuthContext | null | undefined
): boolean {
  return auth?.issuer === WIDGET_SUPPORT_ISSUER;
}

export function widgetContext(
  auth: SessionAuthContext | null | undefined
): WidgetContext | null {
  if (!isWidgetSupport(auth)) {
    return null;
  }
  const parsed = stampedWidgetAttributes.safeParse(auth?.attributes);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function requireWidgetContext(
  auth: SessionAuthContext | null | undefined
): WidgetContext {
  const context = widgetContext(auth);
  if (!context) {
    throw new Error("The verified support scope is unavailable.");
  }
  return context;
}

/** Stamp only server-verified context, unattended so no write policy treats the run as watched. */
export function widgetAuth(
  scope: WidgetContext,
  runId?: string
): SessionAuthContext {
  const {
    helpCenter,
    endpoints,
    featuresOff = featuresOffNames(helpCenter),
    officeHours: _hours,
    ...verified
  } = widgetContextSchema.parse(scope);
  return stampUnattended({
    attributes: {
      ...verified,
      ...(endpoints ? { endpoints: JSON.stringify(endpoints) } : {}),
      ...(featuresOff.length > 0
        ? { featuresOff: JSON.stringify(featuresOff) }
        : {}),
      ...(runId ? { widgetRunId: z.uuid().parse(runId) } : {}),
    },
    authenticator: "bearer",
    issuer: WIDGET_SUPPORT_ISSUER,
    principalId: verified.userId,
    principalType: "service",
  });
}

export function sameWidgetOwner(a: WidgetContext, b: WidgetContext) {
  return (
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.conversationId === b.conversationId &&
    a.role === b.role &&
    a.liveAsOf === b.liveAsOf &&
    a.partnerId === b.partnerId &&
    a.organizationSlug === b.organizationSlug
  );
}
