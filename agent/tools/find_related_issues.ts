import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { findRelatedIssues } from "#lib/linear-api.js";
import { isAutonomous, isIntakeOnly } from "#lib/trust.js";

const relatedIssueSchema = z.object({
  assignee: z.string().nullable(),
  createdAt: z.string(),
  identifier: z.string(),
  labels: z.array(z.string()),
  matchedPhrases: z.array(z.string()),
  parentIdentifier: z.string().nullable(),
  state: z.string(),
  stateType: z.string(),
  title: z.string(),
  url: z.string(),
});

export default defineTool({
  description:
    "Search Linear with fixed queries. scope duplicates: every team, closed and archived included, for prior reports and investigations of the same symptom. " +
    "scope masters: Engineering Team issues eligible to own a root cause; in an intake-only Slack session only issues created in the last 30 days are eligible, elsewhere there is no cutoff, and createdAfter reports which applied. " +
    "Pass 2 to 4 phrasings: the customer outcome, the visible error text, the feature or object name, and for masters the root cause and code path. " +
    "Each hit lists the phrases that matched it. truncated true means candidates were dropped, so narrow the phrases. Read every hit before deciding; a keyword match is not a duplicate.",
  async execute(input, ctx) {
    const auth = ctx.session.auth.current;
    if (isAutonomous(auth)) {
      return {
        createdAfter: null,
        error: "Linear reads are not available to unattended factory runs.",
        issues: [],
        truncated: false,
      };
    }
    try {
      const { token } = await ctx.getToken(linearAuth);
      return await findRelatedIssues(
        token,
        { ...input, windowed: isIntakeOnly(auth) },
        { signal: ctx.abortSignal }
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        createdAfter: null,
        error: error instanceof Error ? error.message : "Linear search failed.",
        issues: [],
        truncated: false,
      };
    }
  },
  inputSchema: z.object({
    phrases: z
      .array(z.string().trim().min(3).max(120))
      .min(1)
      .max(6)
      .describe(
        "Search phrasings; each is matched against title and description."
      ),
    scope: z.enum(["duplicates", "masters"]),
  }),
  outputSchema: z.object({
    createdAfter: z.string().nullable(),
    error: z.string().optional(),
    issues: z.array(relatedIssueSchema),
    truncated: z.boolean(),
  }),
});
