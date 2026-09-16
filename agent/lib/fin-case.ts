import { z } from "zod";
import type { FinContext } from "./fin-scope.js";
import {
  intercomConversationIds,
  intercomLink,
} from "./support/conversation.js";

export const FIN_CASE_TEAM = "Engineering Team";
export const FIN_CASE_TOOL = "file_fin_investigation_ticket";
const ISSUE_IDENTIFIER = /^ENG-\d+$/u;

export const finCaseIdentifier = z.string().regex(ISSUE_IDENTIFIER);

export const finCaseDecision = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("not-needed"),
    reason: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    action: z.literal("file"),
    assignee: z.enum([
      "Aaron Fraga",
      "Koppany Kondricz",
      "Anthony Adewale",
      "James Keeble",
      "Anuj Bhatt",
      "Ebubeker Rexha",
      "Jil Patel",
    ]),
    classification: z.enum([
      "Bug",
      "User Error",
      "Platform Limitation",
      "Not settled",
    ]),
    priority: z.number().int().min(1).max(4),
    project: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(160),
  }),
]);
export type FinCaseDecision = z.infer<typeof finCaseDecision>;
export type FinCaseFiling = Extract<FinCaseDecision, { action: "file" }>;

export const finCaseOutcome = z.strictObject({
  identifier: finCaseIdentifier.optional(),
  message: z.string(),
  outcome: z.enum(["newly-created", "already-tracked", "not-needed", "failed"]),
});
export type FinCaseOutcome = z.infer<typeof finCaseOutcome>;

export const finCaseFailed: FinCaseOutcome = {
  message:
    "The ticket outcome could not be verified. Do not claim success or create a replacement.",
  outcome: "failed",
};

/** The conversation link is the idempotency key, so every ticket carries it twice. */
export const finCaseSource = (scope: FinContext) =>
  `https://app.intercom.com/a/inbox/${scope.intercomAppId}/inbox/shared/all/conversation/${scope.conversationId}`;

export const finCaseLabels = (
  classification: FinCaseFiling["classification"]
) => [
  "intercom-sourced",
  "Customer reported",
  ...(classification === "Not settled" ? [] : [classification]),
];

/** One search shape for filing and for status, so both read the same ticket. */
export const finCaseSearch = (scope: FinContext) => ({
  fields: ["id"],
  includeArchived: true,
  limit: 100,
  query: scope.conversationId,
  team: FIN_CASE_TEAM,
});

const finCaseIssues = z.array(z.looseObject({ id: z.string() }));
export const finCaseList = z.discriminatedUnion("hasNextPage", [
  z.looseObject({ hasNextPage: z.literal(true), issues: finCaseIssues }),
  z.looseObject({ hasNextPage: z.literal(false), issues: finCaseIssues }),
]);

export const finCaseIssue = z.looseObject({
  assignee: z.string().nullish(),
  attachments: z.array(z.looseObject({ url: z.string() })).default([]),
  description: z.string().nullish(),
  id: finCaseIdentifier,
  labels: z.array(z.string()).default([]),
  priority: z.looseObject({ value: z.number() }).nullish(),
  project: z.string().nullish(),
  statusType: z.string(),
  url: z.string(),
});
export type FinCaseIssue = z.infer<typeof finCaseIssue>;

export const formatFinCustomerReport = (summary: string) => {
  // Only the authored source line may name a conversation, so quoted customer
  // links cannot make the ticket ambiguous about which conversation it belongs to.
  const quoted = summary.replace(intercomLink, "[link removed]");
  const longestRun = Math.max(
    0,
    ...Array.from(quoted.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `## Customer report\n\n${fence}text\n${quoted}\n${fence}`;
};

/** Customer-safe wording for each Linear status type. No identifier, no link. */
export const customerCaseStatus: Record<string, string> = {
  backlog:
    "The team has the report tracked in their backlog and has not scheduled work on it yet.",
  canceled:
    "The team closed the report without a change, so no work is planned on it.",
  completed:
    "The report is marked done by the team. That on its own does not confirm the change is deployed or that the behaviour is resolved in your workspace.",
  started: "The team is working on the report now.",
  triage: "The team has the report and is reviewing it before planning work.",
  unstarted:
    "The team has accepted the report and planned it, and work has not started yet.",
};

const oneConversationId = (content: string) => {
  const ids = intercomConversationIds(content);
  return ids.length === 1 ? ids[0] : null;
};

/** The ticket must name this conversation once in its body and once in its links. */
export function assertFinCaseSource(issue: FinCaseIssue, scope: FinContext) {
  const links = issue.attachments
    .map((attachment) => attachment.url)
    .join("\n");
  if (
    oneConversationId(issue.description ?? "") !== scope.conversationId ||
    oneConversationId(links) !== scope.conversationId ||
    !issue.url.startsWith(`https://linear.app/acquisity/issue/${issue.id}/`)
  ) {
    throw new Error("The ticket does not belong to this conversation.");
  }
}

/** Confirms one write landed as asked. Only meaningful right after creating it. */
export function assertFinCaseRouting(
  issue: FinCaseIssue,
  decision: FinCaseFiling
) {
  const labels = new Set(issue.labels);
  if (
    issue.project !== decision.project ||
    issue.assignee !== decision.assignee ||
    issue.priority?.value !== decision.priority ||
    !finCaseLabels(decision.classification).every((label) => labels.has(label))
  ) {
    throw new Error("The ticket routing does not match the filed decision.");
  }
}
