import { createHash } from "node:crypto";
import { z } from "zod";
import { invokeProvider, type ProviderContext } from "../executor/dispatch.js";
import { requireSupportContext, type SupportClaim } from "./auth.js";
import { type CreationRole, INTERCOM_WORKSPACE } from "./config.js";
import { intercomConversationIds, providerData } from "./conversation.js";
import { SupportRefusal } from "./errors.js";
import { writtenIssueId } from "./linear-state.js";
import { recordMatchedSupportIssue, trackSupportIssue } from "./store.js";

export async function matchSupportIssue(
  ctx: ProviderContext,
  issueId: string,
  role: CreationRole
) {
  const claim = requireSupportContext(ctx);
  const result = await invokeProvider(
    ctx,
    "linear.org.workspaceLinear.get_issue",
    { id: issueId }
  );
  if (!result.ok) {
    throw new Error("Could not read the existing Linear record.");
  }
  assertSupportIssueSource(result.data, claim, role);
  const recorded = await recordMatchedSupportIssue(
    claim,
    `create-issue:${role}`,
    result
  );
  await trackSupportIssue(claim, writtenIssueId(result.data));
  return recorded;
}

export function assertSupportIssueSource(
  data: unknown,
  claim: SupportClaim,
  role: CreationRole
) {
  const issue = z
    .object({ description: z.string().nullish() })
    .passthrough()
    .parse(providerData(data));
  const description = issue.description ?? "";
  const sourceIds = intercomConversationIds(description);
  const matches =
    role === "engineering-master"
      ? description.includes(supportIssueMarker(claim, role))
      : sourceIds.length === 1 && sourceIds[0] === claim.conversation;
  if (!matches) {
    throw new SupportRefusal(
      "The existing issue does not identify this Intercom source unambiguously."
    );
  }
}

function supportIssueMarker(claim: SupportClaim, role: CreationRole) {
  return `Foreman support operation: ${createHash("sha256").update(`${claim.conversation}/${claim.thread}/${role}`).digest("hex")}`;
}

export function supportIssueInput(
  claim: SupportClaim,
  role: CreationRole,
  input: Record<string, unknown>
) {
  const source =
    role === "engineering-master"
      ? ""
      : `\nIntercom source: https://app.intercom.com/a/inbox/${INTERCOM_WORKSPACE}/inbox/shared/all/conversation/${claim.conversation}`;
  return {
    ...input,
    description: `${String(input.description ?? "")}\n\n${supportIssueMarker(claim, role)}${source}`,
  };
}
