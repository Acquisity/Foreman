import { defineSchedule } from "eve/schedules";
import slack from "../channels/slack.js";
import { readDocument, SLA_REPORT_PREFIX, writeDocument } from "../lib/blob.js";
import {
  OWNER_USER_ID,
  SLACK_INTAKE_ONLY_CHANNELS,
  SLACK_TEAM_ID,
} from "../lib/constants.js";
import { slaWindowStart } from "../lib/sla-window.js";
import { stampIntakeOnly, stampUnattended } from "../lib/trust.js";

/** Who each channel's report tags. Support is cross-cutting, so it tags both. */
const JAMES = "<@U0BA7JK9XRV>";
const AARON = `<@${OWNER_USER_ID}>`;

const FEATURE_CHANNELS = [
  { channelId: "C0BAA1KUNP8", feature: "Cold Email", tag: JAMES },
  { channelId: "C0BC0H4GA9J", feature: "AI SDR", tag: JAMES },
  { channelId: "C0BAA18DFB8", feature: "CRM", tag: JAMES },
  { channelId: "C0B9WJVRXNK", feature: "AI Website Builder", tag: JAMES },
  { channelId: "C0BB6C1DURW", feature: "Whitelabel Partners", tag: JAMES },
  { channelId: "C0B9WJWTC15", feature: "Support", tag: `${JAMES} ${AARON}` },
] as const;

/**
 * The schedule runs as the owner rather than as the app, because the
 * investigation reaches Sentry and Axiom, which are `principalType: "user"`
 * connections. eve keys stored grants by issuer and principal id, so both
 * must match what an inbound Slack message builds.
 * Delivery is unaffected: Slack posts always go out on the bot token.
 *
 * The user principal would otherwise make these turns look attended, so they
 * carry the unattended stamp: `isUnattended` denies shared-config, Linear, and
 * Supermemory writes outright rather than parking a card on a person who is
 * asleep when this runs.
 *
 * Known gap, deliberately not solved here: if a user grant lapses, eve's
 * default `authorization.required` handler posts "Connect with <name> to
 * continue" into whichever feature channel that session targets, and delivers
 * the sign-in button ephemerally to `attributes.user_id`. The credential never
 * goes public and the notice edits itself once resolved, but the run stalls
 * until a person signs in, which a schedule should not need. The only override
 * is the channel-wide handler in `agent/channels/slack.ts`, which would change
 * behavior for every human Slack session too, so it is a separate decision.
 */
const OWNER_AUTH = stampUnattended({
  attributes: {
    team_id: SLACK_TEAM_ID,
    user_id: OWNER_USER_ID,
  },
  authenticator: "slack-webhook",
  issuer: `slack:${SLACK_TEAM_ID}`,
  principalId: `slack:${SLACK_TEAM_ID}:${OWNER_USER_ID}`,
  principalType: "user",
});

/**
 * The schedule builds its own auth rather than receiving a signed webhook, so
 * it has to apply the intake-only stamp the Slack channel would have applied.
 * Without this a feature channel listed in SLACK_INTAKE_ONLY_CHANNELS would
 * lose its delivery gate for exactly these sessions.
 */
const authFor = (channelId: string) =>
  SLACK_INTAKE_ONLY_CHANNELS.has(channelId)
    ? stampIntakeOnly(OWNER_AUTH)
    : OWNER_AUTH;

const LAST_RUN_KEY = `${SLA_REPORT_PREFIX}last-run.txt`;

/**
 * Start of the window this run reports on. A Blob failure falls back to the
 * first-run window rather than skipping the day: reporting a short window is
 * recoverable, dispatching nothing is not.
 *
 * The marker is written at dispatch rather than at session completion, so a
 * session that fails afterwards loses its window. The heartbeat is what
 * surfaces that; per-feature markers would close it if it proves to matter.
 *
 * `markerRead` gates that write. A read failure must not overwrite a marker
 * this run could not see, or a multi-day gap would be narrowed to one day and
 * lost permanently instead of caught up on the next tick.
 */
const readWindow = async (): Promise<{
  markerRead: boolean;
  since: string;
}> => {
  try {
    const marker = await readDocument(LAST_RUN_KEY);
    return {
      markerRead: true,
      since: slaWindowStart(marker.found ? marker.content : null, Date.now()),
    };
  } catch (error) {
    console.error("SLA report last-run marker read failed.", error);
    return { markerRead: false, since: slaWindowStart(null, Date.now()) };
  }
};

/**
 * 13:00 UTC every day, which is 09:00 America/New_York while daylight saving
 * is in effect and 08:00 once it ends. Vercel evaluates cron in UTC and
 * `defineSchedule` takes no timezone, so a fixed expression cannot track the
 * switch; drifting an hour earlier in winter is the harmless direction for a
 * report whose point is that bugs are not sitting unseen.
 */
export default defineSchedule({
  cron: "0 13 * * *",
  async run({ to, waitUntil }) {
    const { markerRead, since } = await readWindow();
    for (const { feature, channelId, tag } of FEATURE_CHANNELS) {
      try {
        const dispatch = to(slack, { channelId }).send(
          `Daily SLA check for ${feature}. Load the sla-investigation skill and follow it end to end. Find new SLA bugs for ${feature}: Bug label, Urgent or High priority, SLA started at or after ${since}. Run the skill's required investigation on every fresh bug, including opening the repository, before you write anything. A bug already attached to a master ticket is a customer report, not a fresh bug, so the skill reports it as a brief note instead. The repository for any code lookup is Acquisity/Acquisity. Post one report in the skill's format, tagging ${tag} in the header line and each bug's assignee in its own block. Delivery is conditional: if there are no in-scope bugs, reply with exactly <eve-empty-delivery/> and no other text, so nothing at all is posted. Do not explain that you found none.`,
          { auth: authFor(channelId) }
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
        `Daily SLA check health line. Load the sla-investigation skill and run only the Linear query step for every feature: ${FEATURE_CHANNELS.map((entry) => entry.feature).join(", ")}. Do not investigate anything and do not open any other tool. Post exactly one line naming each feature and how many in-scope bugs it has for SLA started at or after ${since}, then one line listing any in-scope bug whose project maps to no feature, by identifier and project, so a new or cross-cutting project is visible instead of dropped. This run always posts, so neither the skill's required investigation nor its empty-delivery rule applies here: never reply with the empty-delivery marker, and report zero counts as zeros.`,
        { auth: authFor(OWNER_USER_ID) }
      );
      waitUntil(
        heartbeat.catch((error) => {
          console.error("SLA report heartbeat dispatch failed.", error);
        })
      );
    } catch (error) {
      console.error("SLA report heartbeat setup failed.", error);
    }

    if (markerRead) {
      waitUntil(
        writeDocument(LAST_RUN_KEY, new Date().toISOString(), {
          allowOverwrite: true,
          contentType: "text/plain",
        }).catch((error) => {
          console.error("SLA report last-run marker write failed.", error);
        })
      );
    }
  },
});
