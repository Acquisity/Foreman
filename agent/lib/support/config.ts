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
export type SupportScheduleMode = "intake" | "followups";
export const supportScheduleEnabled = (mode: SupportScheduleMode) =>
  supportEnabled() &&
  (mode === "intake" ||
    process.env.FOREMAN_SUPPORT_FOLLOWUPS_ENABLED === "true");
export const conversationId = z.string().regex(/^\d{1,30}$/);
export const slackTimestamp = z.string().regex(/^\d{10,16}\.\d{6}$/);

const APP_ID = /^A[A-Z0-9]+$/;
const ISO_FRACTION = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/;
const supportSince = z.iso
  .datetime({ offset: true })
  .refine(
    (iso) =>
      slackTimestamp.safeParse(`${Math.floor(Date.parse(iso) / 1000)}.000000`)
        .success,
    "FOREMAN_SUPPORT_SINCE must fall within the supported Slack timestamp epoch range."
  );

/** Slack's exclusive lower bound retains the configured microseconds, including timezone offsets. */
export function supportInitialTimestamp(since: string) {
  const iso = supportSince.parse(since);
  const seconds = Math.floor(Date.parse(iso) / 1000);
  // Truncation is intentional: an exclusive bound still admits the next newer microsecond.
  const fraction = (ISO_FRACTION.exec(iso)?.[1] ?? "")
    .padEnd(6, "0")
    .slice(0, 6);
  return slackTimestamp.parse(`${seconds}.${fraction}`);
}

export function supportConfig() {
  if (!supportEnabled()) {
    return null;
  }
  const selection = process.env.FOREMAN_SUPPORT_TEST_CONVERSATIONS ?? "";
  return z
    .object({
      appId: z.string().regex(APP_ID),
      since: supportSince,
      testConversations: z
        .array(conversationId)
        .min(selection === "" ? 0 : 1)
        .max(10),
    })
    .parse({
      appId: process.env.FOREMAN_SUPPORT_HANDOFF_APP_ID,
      since: process.env.FOREMAN_SUPPORT_SINCE,
      testConversations: selection
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    });
}
