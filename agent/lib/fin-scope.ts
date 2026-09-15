import { z } from "zod";

const contactId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const conversationId = z.string().regex(/^\d{1,32}$/);
const organizationSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && value === parsed.origin;
  }, "origin must be an HTTPS origin");

/** The complete server-verified scope persisted on a customer investigation. */
export const finContextSchema = z.strictObject({
  contactId,
  conversationId,
  intercomAppId: z.literal("ls8uffkp"),
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(500),
  organizationSlug,
  origin,
  partnerId: z.literal("00000000-0000-0000-0000-000000000001"),
  role: z.enum(["owner", "admin"]),
  userId: z.uuid(),
  verifiedAt: z.iso.datetime(),
});

export type FinContext = Readonly<z.infer<typeof finContextSchema>>;
