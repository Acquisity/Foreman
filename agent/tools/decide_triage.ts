import { defineTool } from "eve/tools";
import { z } from "zod";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { decideTriage } from "#lib/jev-decisions.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { recordFor, regressionRecords } from "#lib/regression-record.js";
import {
  confidenceFields,
  criticRounds,
  decisionFields,
  fallbackDecisionFields,
  recordDecision,
  triageDecisions,
} from "#lib/triage-log.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const text = (max: number) => z.string().trim().min(1).max(max);

export default defineTool({
  approval: () => "not-applicable",
  description:
    "Jev decides the Stage 5 handling for a triage ticket from the completed Stage 4 evidence record: verdict, classification, duplicate, handling path, final state, priority, labels, and project. " +
    "Code applies the Bug bar, the state for each path, the priority rules, and the owner map. " +
    "outcome unproven means take the unproven branch with the missing confirmations it lists. " +
    "confidence carries the verdict, classification and path confidence; below 0.6 on the classification or path the outcome is unproven. " +
    "review says whether a second check by the critic is required for this decision and why; a duplicate, a platform limitation, a user error with a lane that could not run or a failure the customer saw, and an inbox error set aside as billing all need one. " +
    "An inbox error needs billingFacts before it can be a Bug or a duplicate; if they show non-payment, failing payments or domains not live, the decision is billing (Support/Financial), never a code bug. " +
    "A Bug needs check_regression run for the ticket first (label every commit it returns), on exactly the file, function, line range and commit codePath names; its result is read from the session, never passed in, and a result for other code does not count. If the regression check is the only item in missing, run it and call this again: never take the unproven branch or tell the requester for that. A Bug main already fixes comes back as Resolved by triage, state Done (fixed and live), or Support/Product follow-up held by the area owner (fixed, not live yet): neither gets a master. " +
    "For a Bug that is not a Duplicate, hotlane carries the incident-hotlane route, impact, and proposed label. " +
    "outcome route carries the exact state, priority, addLabels (including the Area label), project, assignee, and duplicate fields for route_ticket; pass them unchanged. decision.assignee is the mapped owner of the area it chose, James Keeble when no area fits, and null when the ticket may not go to a developer (not a confirmed Bug, or a feature request nobody approved); decision.area names the Area label the route already carries. approval needed means a feature request waits for James to approve it. " +
    "Put every note in the Triage investigation document. " +
    "decided false means Jev could not answer: decide by the skill's rules and say so in the document; route_ticket then holds any route but the owner assignment until the critic has reviewed the fallback decision.",
  async execute(input, ctx) {
    try {
      const record = recordFor(
        regressionRecords.get()[input.identifier],
        input.codePath
      );
      const decision = await decideTriage(
        {
          ...input,
          ...(record
            ? {
                regression: {
                  commit: record.commit,
                  kind: record.kind,
                  line: record.line,
                  reason: record.reason,
                },
              }
            : {}),
        },
        { signal: ctx.abortSignal }
      );
      logOpsEvent("jev.decision", {
        code: decision.outcome === "route" ? decision.hotlane?.route : null,
        outcome: decision.outcome === "route" ? decision.path : "unproven",
        sessionId: ctx.session.id,
        tool: "decide_triage",
      });
      const fields = decisionFields(input.identifier, decision);
      const settled = recordDecision(
        triageDecisions.get(),
        criticRounds.get(),
        fields
      );
      triageDecisions.update(() => settled.decisions);
      criticRounds.update(() => settled.rounds);
      logOpsEvent("triage.decision", {
        ...fields,
        ...confidenceFields(decision),
        decision: settled.stage,
        sessionId: ctx.session.id,
      });
      return { decided: true as const, decision };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      const fallback = recordDecision(
        triageDecisions.get(),
        criticRounds.get(),
        fallbackDecisionFields(input.identifier)
      );
      triageDecisions.update(() => fallback.decisions);
      criticRounds.update(() => fallback.rounds);
      return {
        decided: false as const,
        error: error instanceof Error ? error.message : "Jev failed.",
      };
    }
  },
  inputSchema: z.object({
    billingFacts: z
      .object({
        checkedAt: text(40).describe("When the facts were read (ISO time)."),
        domainsLive: z
          .boolean()
          .nullable()
          .describe(
            "Whether the workspace's domains are live; null if unknown."
          ),
        organizationId: text(100).describe(
          "The workspace the facts were read for."
        ),
        paymentsFailing: z
          .boolean()
          .nullable()
          .describe("Whether payments are failing; null if unknown."),
        source: text(300).describe("The reads the facts came from."),
        subscriptionPaid: z
          .boolean()
          .nullable()
          .describe("Whether the subscription is paid; null if unknown."),
      })
      .optional()
      .describe(
        "Required when the report is about a sending-inbox error: the billing check read now for the pinned workspace."
      ),
    blastRadius: z
      .object({
        countedAt: text(40).describe("The date the count ran."),
        orgs: z.number().int().min(0),
        query: text(4000).describe("The query that produced the count."),
        users: z.number().int().min(0),
      })
      .optional()
      .describe("Only when a query counted it; omit an estimate."),
    claim: text(1000).describe("The one testable sentence from Stage 1."),
    codePath: z
      .object({
        commit: z
          .string()
          .trim()
          .regex(/^[0-9a-f]{40}$/u),
        file: text(300),
        function: text(200),
        lines: z
          .object({ end: z.number().int(), start: z.number().int() })
          .optional()
          .describe(
            "The line range at commit, the same range passed to check_regression."
          ),
      })
      .optional()
      .describe(
        "The file, function and line range the cause runs through, when found."
      ),
    duplicateCandidates: z
      .array(
        z.object({
          identifier,
          priority: z
            .number()
            .int()
            .min(1)
            .max(4)
            .optional()
            .describe("The candidate's current priority."),
          summary: text(1500).describe("Its symptom, cause, and state."),
          title: text(300),
        })
      )
      .max(8)
      .describe("Every hit from find_related_issues worth comparing."),
    evidence: text(20_000).describe(
      "The Stage 4 evidence record: every lane with what it returned, contrary evidence, the unblock, and what was ruled out."
    ),
    identifier: identifier.describe(
      "The ticket being triaged, such as ENG-123."
    ),
    organizationId: text(100)
      .optional()
      .describe("The workspace the investigation pinned, when it pinned one."),
    projects: z
      .array(z.object({ description: text(300).optional(), name: text(120) }))
      .min(1)
      .max(60)
      .describe("The team's active product projects, read from Linear now."),
    rootCauseLabels: z
      .array(text(120))
      .max(40)
      .describe("The team's Root Cause label names, read from Linear now."),
    sourceLabels: z
      .array(text(120))
      .max(3)
      .describe("The sourceLabels classify_ask returned."),
    ticketLabels: z
      .array(text(120))
      .max(60)
      .describe(
        "Every label already on the ticket, read from Linear now (an empty list when it has none), not the sourceLabels; the Approved label releases a feature request to a developer."
      ),
    unavailableLanes: z
      .array(text(200))
      .max(20)
      .optional()
      .describe(
        "Every Stage 4 lane recorded as 'Could not run', by name; omit when none."
      ),
  }),
});
