import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { findRelatedIssues } from "#lib/linear-api.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

const MAX_ISSUES = 5;

/** Linear's fixed state.type vocabulary; anything else counts as open. */
const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

const knownIssueSchema = z.object({
  identifier: z.string(),
  status: z.string(),
  title: z.string(),
});

type KnownIssue = z.infer<typeof knownIssueSchema>;

/**
 * Runs the shared master-issue search and sanitizes the result down to
 * identifier/title/status only — no descriptions, assignees, or labels that
 * might carry customer names, since this feeds a customer-facing agent.
 * Open issues sort ahead of closed ones, ties broken by recency, before the
 * result is capped.
 */
async function searchKnownIssues(
  query: string,
  opts: { client: ReturnType<typeof executorClient>; signal: AbortSignal }
): Promise<{ error?: string; issues: KnownIssue[] }> {
  try {
    const result = await findRelatedIssues(
      { phrases: [query], scope: "masters", windowed: false },
      opts
    );
    const issues = [...result.issues]
      .sort((a, b) => {
        const aClosed = CLOSED_STATE_TYPES.has(a.stateType) ? 1 : 0;
        const bClosed = CLOSED_STATE_TYPES.has(b.stateType) ? 1 : 0;
        if (aClosed !== bClosed) {
          return aClosed - bClosed;
        }
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, MAX_ISSUES)
      .map((issue) => ({
        identifier: issue.identifier,
        status: issue.state,
        title: issue.title,
      }));
    return { issues };
  } catch (error) {
    if (opts.signal.aborted) {
      throw error;
    }
    return {
      error: "Known-issue search could not run.",
      issues: [],
    };
  }
}

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Check whether a customer symptom matches a known platform issue or incident Engineering is already tracking, so you can set expectations instead of guessing. " +
    "Pass the symptom as a few keywords, for example 'growth plan stuck processing'. Returns up to 5 matching issues with identifier, title, and status only " +
    "(e.g. In Progress / Done) — never descriptions, comments, assignees, or customer names. An empty list means no known issue matched; error set means the search could not run.",
  execute({ query }, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    return searchKnownIssues(query, {
      client: executorClient(ctx),
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({
    query: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .describe("Symptom or keywords in the customer's own words."),
  }),
  outputSchema: z.object({
    error: z.string().optional(),
    issues: z.array(knownIssueSchema),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
