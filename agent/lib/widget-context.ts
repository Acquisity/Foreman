import { z } from "zod";
import { DEFAULT_PARTNER_ID } from "./acquisity-constants.js";
import { acquisityOrigin, readContextBody } from "./fin-context.js";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

/** The app's verified workspace payload; Intercom's app id is irrelevant to the widget and ignored. */
const appContextSchema = z.looseObject({
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(500),
  organizationSlug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  partnerId: z.literal(DEFAULT_PARTNER_ID),
  role: z.enum(["owner", "admin"]),
  userId: z.uuid(),
  verifiedAt: z.iso.datetime(),
});

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
  },
  request: typeof fetch = fetch
): Promise<WidgetContext> {
  const parsed = inputSchema.parse(input);
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
    await readContextBody(response, signal)
  );
  if (verified.organizationId !== parsed.organizationId) {
    throw new Error("The verified workspace does not match this conversation.");
  }
  return Object.freeze(
    widgetContextSchema.parse({
      conversationId: parsed.conversationId,
      organizationId: verified.organizationId,
      organizationName: verified.organizationName,
      organizationSlug: verified.organizationSlug,
      partnerId: verified.partnerId,
      role: verified.role,
      source: input.staff ? "inbox" : "widget",
      userId: verified.userId,
      verifiedAt: verified.verifiedAt,
    })
  );
}
