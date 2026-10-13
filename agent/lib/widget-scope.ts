import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { DEFAULT_PARTNER_ID } from "./acquisity-constants.js";
import { stampUnattended } from "./trust.js";

export const WIDGET_SUPPORT_ISSUER = "foreman:widget-support";

/**
 * Acquisity's support office hours as its context route computes them per
 * request (ENG-15262). Absent means always open, as before the app sent it.
 */
export const officeHoursSchema = z.strictObject({
  customerTimeZone: z.string().min(1).max(100),
  enabled: z.boolean(),
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
});
export type OfficeHours = z.infer<typeof officeHoursSchema>;

const shape = {
  conversationId: z.uuid(),
  // Only the local live harness stamps the original conversation date.
  liveAsOf: z.iso.datetime().optional(),
  // Kept on the run so its finish reads the hours the message was sent in.
  // Never stamped on the session: auth attributes hold strings only.
  officeHours: officeHoursSchema.optional(),
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(500),
  organizationSlug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  partnerId: z.literal(DEFAULT_PARTNER_ID),
  // The Jam id of the screen recording this turn follows up on. Acquisity sets
  // it only after checking the recording's signed conversation reference.
  recordingId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  // Only the replay identity verifier stamps this, never the production app.
  replayCaseId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/)
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
/** Session attributes also carry trust stamps, so reading the scope back strips unknown keys. */
const stampedAttributes = z.object(shape);

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
  const parsed = stampedAttributes.safeParse(auth?.attributes);
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
export function widgetAuth(scope: WidgetContext): SessionAuthContext {
  const { officeHours: _hours, ...verified } = widgetContextSchema.parse(scope);
  return stampUnattended({
    attributes: { ...verified },
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
    a.replayCaseId === b.replayCaseId &&
    a.liveAsOf === b.liveAsOf &&
    a.partnerId === b.partnerId &&
    a.organizationSlug === b.organizationSlug
  );
}
