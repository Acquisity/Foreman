import { createHash } from "node:crypto";
import { z } from "zod";
import { invokeProvider, type ProviderContext } from "../executor/dispatch.js";
import { requireSupportContext, type SupportClaim } from "./auth.js";
import { inspectConversation } from "./conversation.js";
import { decideSupport, pendingFailureReport } from "./decision.js";
import { SupportRefusal, SupportStateConflict } from "./errors.js";
import { readLinearFollowup, recoverSupportIssues } from "./linear-followup.js";
import { digest } from "./linear-state.js";
import { postSupportMessage, readSupportMessages } from "./slack.js";
import {
  attemptSupportDelivery,
  completeSupportDelivery,
  discardSupportReport,
  queueSupportReport,
  requireSupportLease,
  type SupportRow,
  setSupportVersion,
  settleSupport,
  supportOperations,
} from "./store.js";

export const supportReport = z.object({
  alreadyTried: z.string().min(1).max(500),
  draftReply: z.string().max(700).optional(),
  findings: z.string().min(1).max(1200),
  issue: z.string().min(1).max(500),
  missingInformation: z.string().max(500).optional(),
  nextStep: z.string().min(1).max(500),
  retry: z.boolean().default(false),
});

export async function currentConversation(
  ctx: ProviderContext,
  claim: SupportClaim
) {
  const result = await invokeProvider(
    ctx,
    "intercom.org.foremanIntercom.get_conversation",
    { id: claim.conversation }
  );
  if (!result.ok) {
    throw new Error("Intercom conversation access failed.");
  }
  return inspectConversation(result.data, claim.conversation);
}

export async function currentCase(
  ctx: ProviderContext,
  claim: SupportClaim,
  row: SupportRow
) {
  const conversation = await currentConversation(ctx, claim);
  const linear = conversation.closed
    ? { changes: [], snapshot: {}, version: digest({}) }
    : await readLinearFollowup(ctx, row);
  return {
    ...conversation,
    linear,
    revision: digest([conversation.revision, linear.version]),
    version: digest([conversation.version, linear.version]),
  };
}

export async function openSupportInvestigation(ctx: ProviderContext) {
  const claim = requireSupportContext(ctx);
  const row = await requireSupportLease(claim);
  if (pendingFailureReport(row)) {
    await deliverSupportReport(ctx, claim);
    return { investigate: false, reason: "Pending access status handled." };
  }
  const operations = await supportOperations(row);
  const recovered = await recoverSupportIssues(claim, row, operations);
  const current = await currentCase(ctx, claim, recovered);
  const decision = decideSupport(row, {
    ...current,
    hasLinkedIssues: Object.keys(current.linear.snapshot).length > 0,
  });
  // The first intake always leaves a short Slack result, even when no work is needed.
  if (
    !row.processed_version &&
    (decision.kind === "closed" || decision.kind === "unchanged")
  ) {
    await discardSupportReport(claim);
    await setSupportVersion(claim, current.version, current.linear.snapshot);
    const text = current.closed
      ? "Initial check: the Intercom conversation is already closed. No action taken."
      : "Initial check: the Intercom conversation is snoozed with no linked engineering issue to follow. No action taken.";
    await queueSupportReport(
      claim,
      text,
      digest(text),
      "final",
      current.revision
    );
    if (await reserveDelivery(claim)) {
      const ts = await postSupportMessage(
        claim.thread,
        text,
        z.string().parse((await requireSupportLease(claim)).report_key)
      );
      await completeSupportDelivery(claim, ts, current.closed);
    } else {
      await reconcileSupportDelivery(claim, current.closed);
    }
    return { investigate: false, posted: true };
  }
  // biome-ignore lint/style/useDefaultSwitchClause: every decision kind returns; TypeScript checks exhaustiveness.
  switch (decision.kind) {
    case "closed":
      await discardSupportReport(claim);
      await settleSupport(claim, { closed: true });
      return { investigate: false, reason: "Conversation is closed." };
    case "pending-delivery":
      await deliverSupportReport(ctx, claim, current);
      return { investigate: false, reason: "Pending delivery handled." };
    case "reconcile":
      await reconcileSupportDelivery(claim, current.closed);
      return {
        investigate: false,
        reason:
          "Prior delivery reconciled; a later run will check new content.",
      };
    case "unchanged":
      if (decision.discardReport) {
        await discardSupportReport(claim);
      }
      if (decision.processed) {
        await setSupportVersion(
          claim,
          current.version,
          current.linear.snapshot
        );
      }
      await settleSupport(claim, { processed: decision.processed });
      return { investigate: false, reason: "No new actionable case evidence." };
    case "investigate":
      if (decision.discardReport) {
        await discardSupportReport(claim);
      }
      await setSupportVersion(claim, current.version, current.linear.snapshot);
      return {
        conversation: current.conversation,
        humanReplied: current.humanReplied,
        humanTookOwnership: current.humanTookOwnership,
        initialIntake: !row.processed_version,
        instructions:
          "Load intercom-triage-investigate or intercom-billing-triage. Reuse recorded operations and existing helpers. Finish through support_investigation; ordinary final text is not delivered.",
        investigate: true,
        linearChanges: current.linear.changes,
        previousOperations: operations,
        revision: current.revision,
        slackContext: (
          await readSupportMessages({ thread: claim.thread })
        ).filter(
          (message) => message.metadata?.event_type !== "foreman_support"
        ),
      };
  }
}

async function reconcileSupportDelivery(claim: SupportClaim, closed = false) {
  const row = await requireSupportLease(claim);
  const messages = await readSupportMessages({ thread: claim.thread });
  const existing = messages.find(
    (m) =>
      m.client_msg_id === row.report_key ||
      (m.metadata?.event_type === "foreman_support" &&
        m.metadata.event_payload.key === row.report_key)
  );
  if (existing) {
    await completeSupportDelivery(claim, existing.ts, closed);
    return true;
  }
  // Absence from a read is not a provider guarantee that a timed-out post failed.
  throw new Error(
    "Slack delivery is uncertain. Its stable marker was not found; retain the outbox for operator reconciliation."
  );
}

export async function deliverSupportReport(
  ctx: ProviderContext,
  claim: SupportClaim,
  observed?: Awaited<ReturnType<typeof currentCase>>
) {
  const row = await requireSupportLease(claim);
  if (!(row.report && row.report_key)) {
    return false;
  }
  if (row.delivery_attempted) {
    await reconcileSupportDelivery(claim, observed?.closed);
    return true;
  }
  if (row.report_kind === "failure") {
    if (!(await reserveDelivery(claim))) {
      return reconcileSupportDelivery(claim);
    }
    const ts = await postSupportMessage(
      claim.thread,
      row.report,
      row.report_key
    );
    await completeSupportDelivery(claim, ts);
    return true;
  }
  const current = observed ?? (await currentCase(ctx, claim, row));
  if (
    current.closed ||
    current.version !== row.version ||
    current.revision !== row.report_revision
  ) {
    await discardSupportReport(claim);
    await settleSupport(claim, { closed: current.closed });
    return false;
  }
  const text =
    current.humanReplied || current.humanTookOwnership
      ? `Internal context; a teammate has replied or taken ownership.\n${row.report}`
      : row.report;
  if (!(await reserveDelivery(claim))) {
    return reconcileSupportDelivery(claim);
  }
  const ts = await postSupportMessage(claim.thread, text, row.report_key);
  await completeSupportDelivery(claim, ts);
  return true;
}

export async function finishSupportInvestigation(
  ctx: ProviderContext,
  input: z.infer<typeof supportReport>,
  revision: string
) {
  const claim = requireSupportContext(ctx);
  const row = await requireSupportLease(claim);
  const current = await currentCase(ctx, claim, row);
  if (current.closed) {
    if (!row.processed_version) {
      return openSupportInvestigation(ctx);
    }
    await settleSupport(claim, { closed: current.closed });
    return {
      posted: false,
      reason: "Conversation changed; a later run will recheck.",
    };
  }
  if (revision !== current.revision) {
    await setSupportVersion(claim, current.version, current.linear.snapshot);
    return {
      conversation: current.conversation,
      linearChanges: current.linear.changes,
      posted: false,
      reason:
        "Intercom or Linear changed during investigation. Review the new state, including your own edits, then finish again with this revision.",
      revision: current.revision,
    };
  }
  const report = supportReport.parse(input);
  if (
    !report.retry &&
    (await supportOperations(row)).some(
      (operation) => operation.state !== "done"
    )
  ) {
    throw new SupportRefusal(
      "A Linear write still needs retry or reconciliation. Do not mark this investigation complete."
    );
  }
  await setSupportVersion(claim, current.version, current.linear.snapshot);
  const text = [
    `Issue: ${report.issue}`,
    `Already tried: ${report.alreadyTried}`,
    `Findings: ${report.findings}`,
    `Next step: ${report.nextStep}`,
    report.missingInformation
      ? `Missing information: ${report.missingInformation}`
      : "",
    report.draftReply
      ? `Draft customer reply (not sent): ${report.draftReply}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash === row.last_report_hash) {
    await settleSupport(claim, { processed: !report.retry });
    return { posted: false, reason: "Findings are unchanged." };
  }
  await queueSupportReport(
    claim,
    text,
    hash,
    report.retry ? "retry" : "final",
    current.revision
  );
  return { posted: await deliverSupportReport(ctx, claim, current) };
}

export async function skipHandledSupport(ctx: ProviderContext) {
  const claim = requireSupportContext(ctx);
  const row = await requireSupportLease(claim);
  if (!row.processed_version) {
    throw new SupportRefusal(
      "The initial intake must post a concise Slack summary even when nothing was actioned. Use finish with a brief report explaining what was checked, the outcome and why no action was needed."
    );
  }
  const current = await currentCase(ctx, claim, row);
  if (
    !(current.humanReplied || current.humanTookOwnership) ||
    current.version !== row.version
  ) {
    throw new SupportRefusal(
      "Cannot skip an unhandled or changed customer request."
    );
  }
  await settleSupport(claim, { closed: current.closed, processed: true });
  return {
    posted: false,
    reason: "Human-handled case needs no additional findings.",
  };
}

export async function finishSupportQuietly(
  ctx: ProviderContext,
  revision: string
) {
  const claim = requireSupportContext(ctx);
  const row = await requireSupportLease(claim);
  const current = await currentCase(ctx, claim, row);
  if (
    row.report ||
    !row.processed_version ||
    (await supportOperations(row)).some(
      (operation) => operation.state !== "done"
    )
  ) {
    throw new SupportRefusal(
      "Initial or unfinished investigation needs a report or retry, not silent completion."
    );
  }
  if (revision !== current.revision) {
    await setSupportVersion(claim, current.version, current.linear.snapshot);
    return {
      conversation: current.conversation,
      linearChanges: current.linear.changes,
      posted: false,
      reason: "Evidence changed. Review it before deciding to stay quiet.",
      revision: current.revision,
    };
  }
  await setSupportVersion(claim, current.version, current.linear.snapshot);
  await settleSupport(claim, { closed: current.closed, processed: true });
  return {
    posted: false,
    reason: "Checked changes need no support action or message.",
  };
}

/** A bounded access status contains no provider error text or unverified finding. */
export function reportSupportFailure(ctx: ProviderContext) {
  const claim = requireSupportContext(ctx);
  return reportSupportFailureForClaim(claim);
}

export async function reportSupportFailureForClaim(claim: SupportClaim) {
  const row = await requireSupportLease(claim);
  if (row.report) {
    throw new Error("Pending support delivery requires reconciliation.");
  }
  const text =
    "I couldn't complete this investigation because a required source or processing step was unavailable. Aaron can review the Intercom conversation manually. The case remains queued for a later check; no customer response or remediation was sent.";
  const hash = createHash("sha256").update(text).digest("hex");
  if (row.last_report_hash === hash) {
    await settleSupport(claim);
    return { investigate: false, retry: true };
  }
  await queueSupportReport(claim, text, hash, "failure");
  const queued = await requireSupportLease(claim);
  if (!(queued.report && queued.report_key)) {
    throw new Error("Failure status was not queued.");
  }
  if (await reserveDelivery(claim)) {
    const ts = await postSupportMessage(
      claim.thread,
      queued.report,
      queued.report_key
    );
    await completeSupportDelivery(claim, ts);
  }
  return { investigate: false, retry: true };
}

async function reserveDelivery(claim: SupportClaim) {
  try {
    await attemptSupportDelivery(claim);
    return true;
  } catch (error) {
    if (error instanceof SupportStateConflict) {
      return false;
    }
    throw error;
  }
}
