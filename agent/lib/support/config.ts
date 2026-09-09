import { z } from "zod";

export const SUPPORT_CHANNEL = "C0C0DV1AR8T";
export const SUPPORT_TOOLKIT = "foreman-support";
export const SUPPORT_TEAM = "8eaf95ab-56ac-4490-8253-f6a96793dc40";
export const conversationId = z.string().regex(/^\d{1,30}$/);
export const slackTimestamp = z.string().regex(/^\d{10,16}\.\d{6}$/);

const APP_ID = /^A[A-Z0-9]+$/;

export function supportConfig() {
  if (process.env.FOREMAN_SUPPORT_ENABLED !== "true") {
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
