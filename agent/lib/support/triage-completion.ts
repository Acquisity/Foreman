import { z } from "zod";
import type { ProviderContext } from "../executor/dispatch.js";
import { SupportRefusal } from "./errors.js";
import {
  readLinkedIssue,
  readSupportComments,
  readSupportLinear,
} from "./linear-followup.js";
import { writtenIssueId } from "./linear-state.js";
import type { supportOperations } from "./store.js";

const documentSchema = z.object({
  content: z.string().min(1),
  url: z.string().min(1),
});
const issueSchema = z.object({
  assignee: z.string().nullish(),
  labels: z.array(z.string()).default([]),
  parentId: z.string().nullish(),
  priority: z.object({ value: z.number() }).optional(),
  project: z.string().nullish(),
  relations: z.object({ duplicateOf: z.unknown().optional() }).optional(),
  status: z.string(),
});
const CLASSIFICATION = /^\*\*Classification\*\*:\s*([^\r\n]+)/m;
const REVIEW = /^\*\*Review\*\*:\s*([^\r\n]+)/m;
const SETTLED_REVIEW =
  /^(?:Approved \S+ at [a-f0-9]{40}|Adjudicated \S+ at [a-f0-9]{40}: (?:CHALLENGE|INSUFFICIENT_EVIDENCE|review failure)[;:,]?[ \t]+\S.*)$/;

/** Check durable outputs, not whether a model says it loaded the workflow. */
export function assertTriageOutputs(
  rawIssue: unknown,
  rawDocument: unknown,
  comments: unknown[]
) {
  const issue = issueSchema.parse(rawIssue);
  const document = documentSchema.parse(rawDocument);
  const classification = CLASSIFICATION.exec(document.content)?.[1].trim();
  const review = REVIEW.exec(document.content)?.[1].trim() ?? "";
  const urgent = review.startsWith("Stopped: NEEDS_HUMAN_URGENT");
  const reported = comments.some((comment) => {
    const parsed = z.object({ body: z.string() }).safeParse(comment);
    return (
      parsed.success &&
      (urgent
        ? parsed.data.body.trim().length > 0
        : parsed.data.body.includes(document.url))
    );
  });
  if (!reported) {
    throw new SupportRefusal(
      "Complete the required minimal Linear comment before finishing triage."
    );
  }
  if (urgent && issue.assignee === "Aaron Fraga") {
    return;
  }
  if (classification === "Not settled" && review === "Not required") {
    return;
  }
  if (
    !["Bug", "User Error", "Platform Limitation"].includes(classification ?? "")
  ) {
    throw new SupportRefusal(
      "Record the settled classification or the documented unproven/urgent-human branch."
    );
  }
  const duplicate = issue.status === "Duplicate";
  if (classification === "Bug" && !duplicate && !SETTLED_REVIEW.test(review)) {
    throw new SupportRefusal(
      "Complete the one critic review and adjudication, then save the final Review line before finishing triage."
    );
  }
  if (review !== "Not required" && !SETTLED_REVIEW.test(review)) {
    throw new SupportRefusal(
      "Save the settled review before finishing triage, including after reclassification."
    );
  }
  if (
    !(
      issue.assignee &&
      (issue.project || issue.assignee === "Aaron Fraga") &&
      issue.priority
    ) ||
    issue.priority.value < 1 ||
    issue.priority.value > 4 ||
    !issue.status.trim() ||
    issue.status === "Triage" ||
    !["intercom-sourced", "Customer reported"].every((label) =>
      issue.labels.includes(label)
    ) ||
    (classification === "Bug" && !issue.labels.includes("Bug")) ||
    (classification === "Bug" && issue.status === "Todo" && !issue.parentId) ||
    (duplicate && !issue.relations?.duplicateOf)
  ) {
    throw new SupportRefusal(
      "Complete and read back the report's state, priority, labels, project, assignment and applicable master/duplicate relation. Tracking an issue is not Linear routing. Aaron is only the documented ownership fallback."
    );
  }
}

/** The existing creation role identifies the source report across retries. No stage flags. */
export async function requireCompletedSupportTriage(
  ctx: ProviderContext,
  operations: Awaited<ReturnType<typeof supportOperations>>
) {
  const created = operations.find(
    (operation) =>
      operation.operation_key === "create-issue:customer-report" &&
      operation.state === "done"
  );
  if (!created) {
    return;
  }
  const result = z
    .object({ data: z.unknown(), ok: z.literal(true) })
    .parse(created.result);
  const issue = await readLinkedIssue(ctx, writtenIssueId(result.data));
  const documents = z
    .array(z.object({ id: z.string(), title: z.string() }))
    .parse(issue.documents ?? []);
  const matches = documents.filter(
    (entry) => entry.title === "Triage investigation"
  );
  // Intercom Step 7 permits a durable Support follow-up without entering shared Bug triage.
  if (
    matches.length === 0 &&
    issue.project === "Support" &&
    issue.assignee === "Aaron Fraga" &&
    issue.status === "Todo" &&
    Array.isArray(issue.labels) &&
    !issue.labels.includes("Bug") &&
    issue.labels.includes("intercom-sourced") &&
    issue.labels.includes("Customer reported")
  ) {
    return;
  }
  if (matches.length !== 1) {
    throw new SupportRefusal(
      "The customer report needs its one Triage investigation document. Continue triage-handling before finishing; use retry with the specific blocker if required work cannot complete."
    );
  }
  const document = await readSupportLinear(ctx, "get_document", {
    id: matches[0].id,
  });
  const comments = await readSupportComments(ctx, issue.id);
  assertTriageOutputs(issue, document, comments);
}
