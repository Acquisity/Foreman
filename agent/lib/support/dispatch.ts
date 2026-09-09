import type { SessionAuthContext } from "eve/context";
import { type SupportClaim, supportAuth } from "./auth.js";
import {
  type SupportScheduleMode,
  supportConfig,
  supportScheduleEnabled,
} from "./config.js";
import { notificationConversation } from "./conversation.js";
import { readSupportMessages } from "./slack.js";
import {
  claimHandoffs,
  discoverHandoff,
  saveSupportCursor,
  settleSupport,
  supportCursor,
} from "./store.js";

export async function runSupportSchedule(
  mode: SupportScheduleMode,
  appAuth: SessionAuthContext,
  send: (claim: SupportClaim, auth: SessionAuthContext) => Promise<unknown>
) {
  if (!supportScheduleEnabled(mode)) {
    return;
  }
  const config = supportConfig();
  if (!config) {
    return;
  }
  if (mode === "intake") {
    const initial = `${Math.floor(Date.parse(config.since) / 1000)}.000000`;
    const oldest = await supportCursor(initial);
    const messages = await readSupportMessages({ oldest });
    // Sequential inserts preserve the watermark on any partial failure.
    for (const message of messages) {
      const conversation = notificationConversation(message, config.appId);
      if (
        conversation &&
        (!config.testConversations.length ||
          config.testConversations.includes(conversation))
      ) {
        // biome-ignore lint/performance/noAwaitInLoops: commit discoveries before advancing the cursor.
        await discoverHandoff(conversation, message.ts);
      }
    }
    const newest = messages.reduce(
      (latest, m) => (Number(m.ts) > Number(latest) ? m.ts : latest),
      oldest
    );
    await saveSupportCursor(newest);
  }
  const claims = await claimHandoffs(mode, config.testConversations);
  await Promise.all(
    claims.map(async (claim) => {
      try {
        await send(claim, supportAuth(appAuth, claim));
      } catch {
        await settleSupport(claim);
      }
    })
  );
}
