import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";

const FEATURE_CHANNELS = [
  { channelId: "C0BAA1KUNP8", feature: "Cold Email" },
  { channelId: "C0BC0H4GA9J", feature: "AI SDR" },
  { channelId: "C0BAA18DFB8", feature: "CRM" },
  { channelId: "C0B9WJVRXNK", feature: "AI Website Builder" },
  { channelId: "C0BB6C1DURW", feature: "Whitelabel Partners" },
] as const;

export default defineSchedule({
  cron: "0 9 * * *",
  run({ to, waitUntil, appAuth }) {
    for (const { feature, channelId } of FEATURE_CHANNELS) {
      try {
        const dispatch = to(slack, { channelId }).send(
          `Daily SLA check for ${feature}. Load the sla-investigation skill, then find new SLA bugs for ${feature}: Bug label, Urgent or High priority, SLA started within the last 24 hours. For each one, investigate and post a bottom-line report (What is it, blast radius / users impacted, linked ticket) and tag James Keeble. If there are none, post nothing.`,
          { auth: appAuth }
        );
        waitUntil(
          dispatch.catch((error) => {
            console.error(
              `SLA report dispatch failed for ${feature} (${channelId}).`,
              error
            );
          })
        );
      } catch (error) {
        console.error(
          `SLA report setup failed for ${feature} (${channelId}).`,
          error
        );
      }
    }
  },
});
