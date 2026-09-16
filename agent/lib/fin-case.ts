import { z } from "zod";
import type { FinContext } from "./fin-scope.js";
import { intercomConversationIds } from "./support/conversation.js";

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
    customerSummary: z.string().trim().min(1).max(300),
    priority: z.number().int().min(1).max(4),
    project: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(160),
  }),
]);
export type FinCaseDecision = z.infer<typeof finCaseDecision>;
export type FinCaseFiling = Extract<FinCaseDecision, { action: "file" }>;
export const finCaseOutcome = z.object({
  identifier: z
    .string()
    .regex(/^ENG-\d+$/)
    .optional(),
  message: z.string(),
  outcome: z.enum(["newly-created", "already-tracked", "not-needed", "failed"]),
});
export type FinCaseOutcome = z.infer<typeof finCaseOutcome>;

export function sameFinCaseOwner(a: FinContext, b: FinContext) {
  return (
    a.userId === b.userId &&
    a.organizationId === b.organizationId &&
    a.contactId === b.contactId &&
    a.intercomAppId === b.intercomAppId &&
    a.organizationSlug === b.organizationSlug &&
    a.partnerId === b.partnerId &&
    a.origin === b.origin
  );
}

export const finCaseSource = (scope: FinContext) =>
  `https://app.intercom.com/a/inbox/${scope.intercomAppId}/inbox/shared/all/conversation/${scope.conversationId}`;
export const finCaseMarker = (id: string) => `Foreman Fin case: ${id}`;

export const finCaseIssue = z.object({
  assignee: z.string().nullable(),
  attachments: z.array(z.object({ url: z.string() })),
  description: z.string().max(100_000),
  documents: z.array(z.object({ id: z.string(), title: z.string() })),
  id: z.string().regex(/^ENG-\d+$/),
  labels: z.array(z.string()),
  priority: z.object({ value: z.number() }).nullable(),
  project: z.string().nullable(),
  statusType: z.enum([
    "triage",
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
  ]),
  url: z.string().url(),
});
export type FinCaseIssue = z.infer<typeof finCaseIssue>;

/** A source link establishes the report, never access to its parent or comments. */
export function assertFinCaseSource(issue: FinCaseIssue, scope: FinContext) {
  const ids = intercomConversationIds(issue.description);
  const attachmentIds = intercomConversationIds(
    issue.attachments.map((a) => a.url).join("\n")
  );
  if (
    ids.length !== 1 ||
    ids[0] !== scope.conversationId ||
    attachmentIds.length !== 1 ||
    attachmentIds[0] !== scope.conversationId ||
    !issue.url.startsWith(`https://linear.app/acquisity/issue/${issue.id}/`)
  ) {
    throw new Error("The ticket is not an unambiguous source report.");
  }
}

export function assertFinCaseRouting(
  issue: FinCaseIssue,
  input: FinCaseFiling
) {
  const labels = [
    "intercom-sourced",
    "Customer reported",
    ...(input.classification === "Not settled" ? [] : [input.classification]),
  ];
  if (
    issue.project !== input.project ||
    issue.assignee !== input.assignee ||
    issue.priority?.value !== input.priority ||
    !labels.every((label) => issue.labels.includes(label))
  ) {
    throw new Error("Ticket routing was not confirmed.");
  }
}

export const customerCaseStatus = {
  backlog: "The report is recorded for follow-up.",
  canceled:
    "The ticket is closed without a confirmed resolution for your workspace.",
  completed:
    "The ticket is marked done. This alone does not confirm deployment or resolution for your workspace.",
  started: "The team is working on the follow-up.",
  triage: "The report is awaiting review.",
  unstarted: "The follow-up has not started yet.",
} as const;

export const formatFinCustomerReport = (summary: string) => {
  const longestRun = Math.max(
    0,
    ...Array.from(summary.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `## Customer report\n\n${fence}text\n${summary}\n${fence}`;
};
