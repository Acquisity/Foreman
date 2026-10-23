import { defineState } from "eve/context";
import { z } from "zod";
import { CRITIC_CRITERIA, CRITIC_VERDICTS } from "../subagents/critic/agent.js";
import type { TriageDecision } from "./jev-decisions.js";

/**
 * Countable triage outcomes (ENG-16049). Every line carries the issue id, so
 * verdicts and later corrections can be counted per ticket. `decide_triage`
 * logs `triage.decision` each time it settles (`decide`, then `adjudicate`
 * when the critic's adjudication re-runs it), unproven outcomes included, and
 * keeps the latest decision per issue; `route_ticket` logs a `route` line
 * only for an issue that has a decision; and the root's hook logs
 * `critic.verdict` against the issue named on the dispatch's first line,
 * and logs nothing for a critic call that named none.
 */
export interface LatestTriageDecision {
  classification: string | null;
  issue: string;
  outcome: "route" | "unproven";
  path: string | null;
}

export const triageDecisions = defineState<
  Record<string, LatestTriageDecision>
>("foreman.triageDecisions", () => ({}));

export const criticTaskIssues = defineState<Record<string, string>>(
  "foreman.criticTaskIssues",
  () => ({})
);

export function settleDecision(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  decision: LatestTriageDecision
) {
  return {
    decisions: { ...decisions, [decision.issue]: decision },
    stage: decision.issue in decisions ? "adjudicate" : "decide",
  } as const;
}

const SOURCE_LINE = /^\**Source issue:\**\s*`?([A-Z]{2,10}-\d{1,9})`?\.?\**$/u;

export function criticTaskIssue(input: unknown): string | null {
  const message = (input as { message?: unknown } | null)?.message;
  if (typeof message !== "string") {
    return null;
  }
  return SOURCE_LINE.exec(message.split("\n", 1)[0]?.trim() ?? "")?.[1] ?? null;
}

export function decisionFields(
  issue: string,
  decision: TriageDecision
): LatestTriageDecision {
  return decision.outcome === "route"
    ? {
        classification: decision.classification,
        issue,
        outcome: "route",
        path: decision.path,
      }
    : { classification: null, issue, outcome: "unproven", path: null };
}

const criticReply = z.object({
  blocking_findings: z.array(z.unknown()),
  criteria_results: z.array(
    z.object({ criterion: z.enum(CRITIC_CRITERIA), result: z.string() })
  ),
  verdict: z.enum(CRITIC_VERDICTS),
});

export interface CriticVerdictFields {
  blockingFindings: number | null;
  failedCriteria: number | null;
  verdict: (typeof CRITIC_VERDICTS)[number] | "failed";
}

/**
 * Reads the critic's settled output. A delegation error, a cancellation, or a
 * reply that doesn't match the critic's contract is a failed review.
 */
export function criticVerdictFields(
  status: string,
  output: unknown
): CriticVerdictFields {
  const failed = {
    blockingFindings: null,
    failedCriteria: null,
    verdict: "failed",
  } as const;
  if (status !== "completed") {
    return failed;
  }
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return failed;
    }
  }
  const parsed = criticReply.safeParse(value);
  if (!parsed.success) {
    return failed;
  }
  return {
    blockingFindings: parsed.data.blocking_findings.length,
    failedCriteria: parsed.data.criteria_results.filter(
      (entry) => entry.result === "FAIL"
    ).length,
    verdict: parsed.data.verdict,
  };
}

export function routeDecisionEvent(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  input: {
    assignee?: string;
    duplicateOf?: string;
    inheritAssigneeFrom?: string;
    issue: string;
    project?: string;
  }
) {
  const decision = decisions[input.issue];
  if (!decision) {
    return null;
  }
  return {
    assigneeKind: assigneeKind(input),
    classification: decision.classification,
    decision: "route",
    duplicateOf: input.duplicateOf ?? null,
    issue: input.issue,
    outcome: decision.outcome,
    path: decision.path,
    project: input.project ?? null,
  };
}

export const criticVerdictIssue = (
  bindings: Readonly<Record<string, string>>,
  callId: string
): string | null => bindings[callId] ?? null;

/** The route's assignee as a kind, never a person's name in the log. */
export const assigneeKind = (input: {
  assignee?: string;
  inheritAssigneeFrom?: string;
}) => {
  if (input.inheritAssigneeFrom) {
    return "inherited";
  }
  return input.assignee ? "named" : "none";
};
