import type { SessionAuthContext } from "eve/context";
import { logOpsEvent } from "../ops-log.js";
import { type SupportClaim, supportAuth } from "./auth.js";
import {
  type SupportScheduleMode,
  supportConfig,
  supportInitialTimestamp,
  supportScheduleEnabled,
} from "./config.js";
import { notificationConversation } from "./conversation.js";
import { reportSupportFailureForClaim } from "./investigation.js";
import { readSupportIntake } from "./slack.js";
import {
  claimHandoffs,
  discoverHandoff,
  findSupportLease,
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
    const initial = supportInitialTimestamp(config.since);
    const checkpoint = await supportCursor(initial);
    const batch = await readSupportIntake(checkpoint);
    // Sequential inserts preserve the watermark on any partial failure.
    for (const message of batch.messages) {
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
    await saveSupportCursor(checkpoint, batch.checkpoint);
  }
  const claims = await claimHandoffs(mode, config.testConversations);
  await Promise.all(
    claims.map(async (claim) => {
      try {
        if (claim.reclaimed) {
          const row = await findSupportLease(claim);
          if (row && !row.processed_version && !row.report) {
            // A parent turn may end while its delegates work. Only an expired
            // initial lease produces the fallback; pending delivery reconciles first.
            await reportSupportFailureForClaim(claim);
            return;
          }
        }
        await send(claim, supportAuth(appAuth, claim));
      } catch {
        logOpsEvent("support.dispatch.failed", { outcome: "error" });
        const row = await findSupportLease(claim);
        if (row && !row.report) {
          await settleSupport(claim);
        }
      }
    })
  );
}
