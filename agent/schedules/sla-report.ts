import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { readDocument, SLA_REPORT_PREFIX, writeDocument } from "../lib/blob.js";
import { slaWindowStart } from "../lib/sla-window.js";

const FEATURE_CHANNELS = [
  { channelId: "C0BAA1KUNP8", feature: "Cold Email" },
  { channelId: "C0BC0H4GA9J", feature: "AI SDR" },
  { channelId: "C0BAA18DFB8", feature: "CRM" },
  { channelId: "C0B9WJVRXNK", feature: "AI Website Builder" },
  { channelId: "C0BB6C1DURW", feature: "Whitelabel Partners" },
] as const;

const SLACK_TEAM_ID = "T0A9AUZJXC2";
const OWNER_USER_ID = "U0BBHB86PUY";

/**
 * The schedule runs as the owner rather than as the app, because the
 * investigation reaches PlanetScale, Sentry, and Axiom, which are all
 * `principalType: "user"` connections. eve keys stored grants by issuer and
 * principal id, so both must match what an inbound Slack message builds.
 * Delivery is unaffected: Slack posts always go out on the bot token.
 */
const OWNER_AUTH = {
  attributes: { team_id: SLACK_TEAM_ID, user_id: OWNER_USER_ID },
  authenticator: "slack-webhook",
  issuer: `slack:${SLACK_TEAM_ID}`,
  principalId: `slack:${SLACK_TEAM_ID}:${OWNER_USER_ID}`,
  principalType: "user",
} as const;

const LAST_RUN_KEY = `${SLA_REPORT_PREFIX}last-run.txt`;

/**
 * Start of the window this run reports on. A Blob failure falls back to the
 * first-run window rather than skipping the day: reporting a short window is
 * recoverable, dispatching nothing is not.
 *
 * The marker is written at dispatch rather than at session completion, so a
 * session that fails afterwards loses its window. The heartbeat is what
 * surfaces that; per-feature markers would close it if it proves to matter.
 */
const windowStartIso = async (): Promise<string> => {
  try {
    const marker = await readDocument(LAST_RUN_KEY);
    return slaWindowStart(marker.found ? marker.content : null, Date.now());
  } catch (error) {
    console.error("SLA report last-run marker read failed.", error);
    return slaWindowStart(null, Date.now());
  }
};

export default defineSchedule({
  cron: "0 9 * * *",
  async run({ to, waitUntil }) {
    const since = await windowStartIso();
    for (const { feature, channelId } of FEATURE_CHANNELS) {
      try {
        const dispatch = to(slack, { channelId }).send(
          `Daily SLA check for ${feature}. Load the sla-investigation skill, then find new SLA bugs for ${feature}: Bug label, Urgent or High priority, SLA started at or after ${since}. For each one, investigate and post a bottom-line report (What is it, blast radius / users impacted, linked ticket) and tag James Keeble. If there are none, post nothing.`,
          { auth: OWNER_AUTH }
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

    try {
      const heartbeat = to(slack, { channelId: OWNER_USER_ID }).send(
        `Daily SLA check health line. Load the sla-investigation skill and run only the Linear query step for every feature: ${FEATURE_CHANNELS.map((entry) => entry.feature).join(", ")}. Do not investigate anything and do not open any other tool. Post exactly one line naming each feature and how many in-scope bugs it has for SLA started at or after ${since}. This run always posts, so the skill's rule about staying silent when there are no bugs does not apply here: report zero counts as zeros.`,
        { auth: OWNER_AUTH }
      );
      waitUntil(
        heartbeat.catch((error) => {
          console.error("SLA report heartbeat dispatch failed.", error);
        })
      );
    } catch (error) {
      console.error("SLA report heartbeat setup failed.", error);
    }

    waitUntil(
      writeDocument(LAST_RUN_KEY, new Date().toISOString(), {
        allowOverwrite: true,
        contentType: "text/plain",
      }).catch((error) => {
        console.error("SLA report last-run marker write failed.", error);
      })
    );
  },
});
