import { z } from "zod";
import { ENGINEERING_TEAM_ID } from "../linear-api.js";

export const SUPPORT_CHANNEL = "C0C0DV1AR8T";
export const SUPPORT_TEAM = ENGINEERING_TEAM_ID;
export const INTERCOM_WORKSPACE = "ls8uffkp";
export const creationRole = z.enum([
  "customer-report",
  "billing",
  "engineering-master",
]);
export type CreationRole = z.infer<typeof creationRole>;
export const supportEnabled = () =>
  process.env.FOREMAN_SUPPORT_ENABLED === "true";
export const conversationId = z.string().regex(/^\d{1,30}$/);
export const slackTimestamp = z.string().regex(/^\d{10,16}\.\d{6}$/);

const APP_ID = /^A[A-Z0-9]+$/;

export function supportConfig() {
  if (!supportEnabled()) {
    return null;
  }
  return z
    .object({
      appId: z.string().regex(APP_ID),
      since: z.iso.datetime({ offset: true }),
      testConversations: z.array(conversationId).max(10),
    })
    .parse({
      appId: process.env.FOREMAN_SUPPORT_HANDOFF_APP_ID,
      since: process.env.FOREMAN_SUPPORT_SINCE,
      testConversations: (process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS ?? "")
        .split(",")
        .filter(Boolean),
    });
}
