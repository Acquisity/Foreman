import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { UNATTENDED_ATTRIBUTE } from "../lib/trust.js";

/** The channel the daily cost report posts into. */
const FOREMAN_COSTS_CHANNEL = "C0BQJB3RX97";

/**
 * 13:00 UTC every day, the same slot as the SLA report. Yesterday is closed
 * on both billing sources by then: FOCUS rows are Pacific days that end at
 * 07:00 or 08:00 UTC, and the gateway report is in UTC.
 *
 * The session runs as the app principal, marked unattended because nobody is
 * watching to answer a card. `read_foreman_costs` admits that principal
 * directly; Slack delivery goes out on the bot token as always.
 */
export default defineSchedule({
  cron: "0 13 * * *",
  run({ to, waitUntil, appAuth }) {
    const dispatch = to(slack, { channelId: FOREMAN_COSTS_CHANNEL }).send(
      "Daily Foreman running-cost report. Call read_foreman_costs once with no input and post its report field as the whole message, unchanged. Call no other tool and add nothing. If available is false, post one line saying the cost report could not be produced and the reason it gives.",
      {
        auth: {
          ...appAuth,
          attributes: { ...appAuth.attributes, [UNATTENDED_ATTRIBUTE]: "true" },
        },
      }
    );
    waitUntil(
      dispatch.catch((error) => {
        console.error("Foreman cost report dispatch failed.", error);
      })
    );
  },
});
