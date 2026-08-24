import type { SessionAuthContext } from "eve/context";
import {
  clearBillingApiRead,
  stampBillingApiRead,
  stampIntakeOnly,
} from "./trust.js";

// Slack channel IDs: an uppercase letter class then base-32-ish characters.
// Anything else in the env list is a typo (a channel name, a quoted value),
// and silently keeping it would leave the gate off for the channel it was
// meant to cover, so it is dropped loudly instead.
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{7,}$/u;

export interface SlackIntakeWorkflow {
  mode: "existing-linear-issue" | "new-linear-issue";
  skills: readonly string[];
}

const PRODUCT_TRIAGE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "existing-linear-issue",
  skills: ["triage-investigate", "clarify-with-requester", "slack-wording"],
};

const BILLING_TRIAGE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "existing-linear-issue",
  skills: ["billing-triage", "clarify-with-requester", "slack-wording"],
};

const INTERCOM_INTAKE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "new-linear-issue",
  skills: [
    "intercom-triage-investigate",
    "intercom-billing-triage",
    "clarify-with-requester",
    "slack-wording",
  ],
};

export const SLACK_INTAKE_WORKFLOWS: Readonly<
  Record<string, SlackIntakeWorkflow>
> = {
  C0BBPVC3N2X: PRODUCT_TRIAGE_WORKFLOW,
  C0BC011NAQL: BILLING_TRIAGE_WORKFLOW,
  C0BCV1WBR42: INTERCOM_INTAKE_WORKFLOW,
  C0BLFDUN6Q7: PRODUCT_TRIAGE_WORKFLOW,
  C0BMXPV6EGJ: BILLING_TRIAGE_WORKFLOW,
  C0BNCL031AQ: INTERCOM_INTAKE_WORKFLOW,
};

const INTAKE_ONLY_BOUNDARY = [
  "This message came from a Slack channel that is intake-only. You may answer questions, investigate, clarify with the requester, and create or update Linear records.",
  "Do not implement a fix or make local code changes. Do not commit, push a branch, open a pull request, or start the factory implementation pipeline. Push and pull-request creation are denied independently of these instructions.",
  "The final post in the Slack thread must contain only the requester-facing reply. Never combine an internal investigation summary, Linear update report, or proof of work with that reply. Normal conversational progress updates are allowed; this boundary applies to the closing post.",
].join("\n\n");

const GENERIC_NEW_ISSUE_TASK = [
  "Use the generic new-issue workflow. This intake-only channel is not mapped to a dedicated procedure.",
  "Investigate the request using the available evidence. Create exactly one unassigned Linear issue containing the request and your findings. Answer in the Slack thread, then stop before implementation.",
].join("\n\n");

const intercomIssueTask = (skills: readonly string[]): string =>
  [
    `Use the Intercom-native investigation workflow. Before investigating, load every required skill for this channel: ${skills.join(", ")}.`,
    "Require exactly one live Intercom conversation URL or reference from the Slack request and treat that conversation as the source. No Linear issue is expected at the start. If the conversation reference is missing or ambiguous, ask for it, then stop.",
    "Classify the predominant ask as product/feedback or billing. Both lanes are valid in this channel: follow the matching Intercom skill without redirecting the requester to another Slack channel.",
    "Investigate before creating Linear work. Non-bug product findings do not create engineering work. Confirmed bugs and actionable billing findings create the records and investigation documents required by their loaded procedures, retaining the Intercom conversation URL and bounded context.",
    "Answer in the Slack thread using slack-wording only after the required Linear operations. Put only the requester-facing answer in the final post, with no internal summary or action log, then stop before implementation.",
  ].join("\n\n");

const existingIssueTask = (skills: readonly string[]): string =>
  [
    `Use the existing-issue Linear workflow. Before investigating, load every required skill for this channel: ${skills.join(", ")}.`,
    "Identify exactly one existing Linear issue from the Slack thread context and treat it as the source of truth. Investigate and update that issue according to the loaded procedures.",
    "Never create a duplicate Linear issue. If the thread does not identify exactly one issue, ask the requester for its Linear link or identifier, then stop.",
    "Answer in the Slack thread using slack-wording. Put only the requester-facing answer in the final post, with no internal summary or action log, then stop.",
  ].join("\n\n");

export function resolveSlackIntakeWorkflow(
  channelId: string
): SlackIntakeWorkflow | undefined {
  return SLACK_INTAKE_WORKFLOWS[channelId];
}

/**
 * Applies the hard intake boundary and any workflow-specific service access.
 */
export function stampSlackIntakeAuth(
  auth: SessionAuthContext,
  channelId: string
): SessionAuthContext {
  const intake = stampIntakeOnly(clearBillingApiRead(auth));
  const workflow = resolveSlackIntakeWorkflow(channelId);
  return workflow === BILLING_TRIAGE_WORKFLOW ||
    workflow === INTERCOM_INTAKE_WORKFLOW
    ? stampBillingApiRead(intake)
    : intake;
}

export function slackIntakeContext(channelId: string): string {
  const workflow = resolveSlackIntakeWorkflow(channelId);
  let task = GENERIC_NEW_ISSUE_TASK;
  if (workflow?.mode === "existing-linear-issue") {
    task = existingIssueTask(workflow.skills);
  } else if (workflow?.mode === "new-linear-issue") {
    task = intercomIssueTask(workflow.skills);
  }
  return [INTAKE_ONLY_BOUNDARY, task].join("\n\n");
}

// Parses a comma-separated list of Slack channel IDs into a Set, trimming
// whitespace and dropping empty entries. Pure so tests can import it without
// triggering the env reads in constants.ts.
export function parseIntakeOnlyChannels(raw: string | undefined): Set<string> {
  const channels = new Set<string>();
  if (raw === undefined) {
    return channels;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toUpperCase();
    if (trimmed === "") {
      continue;
    }
    if (CHANNEL_ID_PATTERN.test(trimmed)) {
      channels.add(trimmed);
    } else {
      console.warn(
        `SLACK_INTAKE_ONLY_CHANNELS: ignoring "${trimmed}", not a Slack channel ID.`
      );
    }
  }
  return channels;
}
