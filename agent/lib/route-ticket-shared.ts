import type { LinearOperation } from "./linear-operations.js";

/** Types and reads every route_ticket module shares. */

export interface Named {
  id: string;
  name: string;
}

export interface RouteTicketInput {
  addLabels?: string[];
  assignee?: string;
  duplicateOf?: string;
  inheritAssigneeFrom?: string;
  issue: string;
  links?: Array<{ title: string; url: string }>;
  parent?: string;
  priority?: number;
  project?: string;
  /** A match the report stays open beside: it joins the match's open master, or waits for grouping. */
  relatedTo?: string;
  releaseDeveloper?: boolean;
  removeLabels?: string[];
  state?: string;
}

export interface RouteTicketResult {
  assignee: string | null;
  duplicateOf: string | null;
  /** With a match: joined its open master, or left open for the grouping sweep. */
  grouping: "joined" | "needs-grouping" | null;
  identifier: string;
  labels: string[];
  parentIdentifier: string | null;
  priority: number;
  projectId: string | null;
  projectName: string | null;
  state: string;
  url: string;
  /** Steps after the issue update that failed; the update itself landed. */
  warnings: string[];
}

/** Reads one issue by identifier, throwing when Linear has no such issue. */
export async function requireIssue(
  gql: Gql,
  identifier: string
): Promise<RouteIssue> {
  const { issue } = await gql<{ issue: RouteIssue | null }>("RouteIssue", {
    id: identifier,
  });
  if (!issue) {
    throw new Error(`No issue ${identifier}.`);
  }
  return issue;
}

/** Resolves one name to exactly one id, or throws naming what was found. */
export function exactlyOne(kind: string, name: string, nodes: Named[]): string {
  if (nodes.length === 1 && nodes[0]) {
    return nodes[0].id;
  }
  if (nodes.length === 0) {
    throw new Error(`No ${kind} named "${name}".`);
  }
  throw new Error(
    `${nodes.length} ${kind}s match "${name}": ${nodes.map((node) => node.name).join(", ")}.`
  );
}

export type Gql = <T>(
  operation: LinearOperation,
  variables: Record<string, unknown>
) => Promise<T>;

export interface RouteIssue {
  assignee: Named | null;
  id: string;
  identifier: string;
  labels: { nodes: Named[] };
  parent: { identifier: string } | null;
  priority: number;
  project: Named | null;
  state: { name: string };
  team: { id: string };
  url: string;
}

export const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const named = (state: string | undefined, ...names: string[]) =>
  state !== undefined && names.includes(state.trim().toLowerCase());

/**
 * The labels the ticket keeps once this call's removals land. route_ticket's
 * write and its closure guards both start from this, so they judge the same
 * label set the write saves.
 */
export const keptLabels = (
  issue: RouteIssue,
  input: RouteTicketInput
): Named[] => {
  const removed = new Set(
    (input.removeLabels ?? []).map((name) => name.toLowerCase())
  );
  return issue.labels.nodes.filter(
    (label) => !removed.has(label.name.toLowerCase())
  );
};
