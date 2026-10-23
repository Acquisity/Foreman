import { z } from "zod";
import type { TriageCase } from "./schema.js";

/**
 * The simulated Linear workspace one replay session sees (ENG-16049).
 *
 * It answers the authored Linear operations from the frozen case, as of the
 * case's creation, and records every write instead of sending it. Each answer
 * carries provenance: `seeded` when it comes from the case or the frozen
 * lists, `generated` when it returns something this replay wrote, such as
 * Foreman's own investigation document read back for the critic. The scorer's
 * leakage check reads only seeded inputs.
 */

const named = z.strictObject({
  createdAt: z.iso.datetime().optional(),
  id: z.string(),
  name: z.string(),
});
const labelEntry = named.extend({ group: z.string().optional() });
const projectEntry = named.extend({
  canceledAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});
const user = named.extend({
  displayName: z.string().optional(),
  email: z.string().optional(),
});

export const frozenListsSchema = z.strictObject({
  labels: z.array(labelEntry),
  projects: z.array(projectEntry),
  states: z.array(named),
  users: z.array(user),
});
export type FrozenLists = z.infer<typeof frozenListsSchema>;
export const FROZEN_LISTS = ["labels", "projects", "states", "users"] as const;
export type FrozenList = (typeof FROZEN_LISTS)[number];

interface StoredDocument {
  content: string;
  id: string;
  issueId: string;
  title: string;
  updatedAt: string;
}

export interface IssueFields {
  assignee: string | null;
  labels: string[];
  parent: string | null;
  priority: number;
  project: string | null;
  state: string;
}

export interface ReplayInput {
  availableAt: string | null;
  content: string;
  provenance: "seeded" | "generated";
  source: string;
}

export interface ReplayDecision {
  issue: string | null;
  kind: "billing" | "triage";
  output: unknown;
}

interface CreatedIssue {
  description: string;
  fields: IssueFields;
  identifier: string;
  title: string;
}

export interface ReplayStamp {
  estimatedUsd: number;
  foremanCommit: string;
  startedAt: string;
}

export const UNSTAMPED: ReplayStamp = {
  estimatedUsd: 0,
  foremanCommit: "unknown",
  startedAt: "1970-01-01T00:00:00.000Z",
};

export interface ReplayState {
  /** The case's pinned repository archive in Blob; the only code the replay can read. */
  archive: { commit: string; url: string };
  calls: Record<string, { input: Record<string, unknown>; tool: string }>;
  /** Why the replay hook cancelled the run, or null. */
  cancelled: string | null;
  case: TriageCase;
  clock: number;
  /** The cohort hash the runner verified when it started this replay; every result carries it. */
  cohortSha256: string;
  comments: { body: string; issue: string }[];
  created: CreatedIssue[];
  critic: {
    blockingFindings: number;
    failedCriteria: number;
    verdict: "APPROVE" | "CHALLENGE" | "INSUFFICIENT_EVIDENCE" | "failed";
  } | null;
  /** Every settled decide_triage and decide_billing result, in order; the last one is the final decision. */
  decisions: ReplayDecision[];
  documents: StoredDocument[];
  evidenceMisses: string[];
  inputs: ReplayInput[];
  /** The case ticket's fields as routing changed them. */
  issue: IssueFields;
  listMembershipUnknown: FrozenList[];
  lists: FrozenLists;
  memory: unknown[];
  relations: { issueId: string; relatedIssueId: string; type: string }[];
  replies: { issue: string; message: string }[];
  rootTurn: "completed" | "failed" | "cancelled" | null;
  routeResults: { issue: string | null; routed: boolean }[];
  /** Every RouteIssueUpdate the store applied to the case ticket. */
  routes: { input: Record<string, unknown>; seq: number }[];
  /** What the server stamps on this replay's result: its commit, start time and charged cost. */
  stamp: ReplayStamp;
  steps: number;
  writes: { operation: string; seq: number; variables: unknown }[];
}

export const CASE_ISSUE_ID = "replay-case";
export const issueIdOf = (identifier: string) => `replay-${identifier}`;
export const urlOf = (identifier: string) =>
  `https://linear.app/acquisity/issue/${identifier}/replay`;

/** A fresh store for one case: the ticket as created, no comments, no documents. */
export function seedReplayState(
  triageCase: TriageCase,
  lists: FrozenLists,
  archiveUrl: string,
  cohortSha256 = "",
  stamp: ReplayStamp = UNSTAMPED
): ReplayState {
  return {
    archive: { commit: triageCase.repoCommitAtCreate, url: archiveUrl },
    calls: {},
    cancelled: null,
    case: triageCase,
    clock: 0,
    cohortSha256,
    comments: [],
    created: [],
    critic: null,
    decisions: [],
    documents: [],
    evidenceMisses: [],
    inputs: [
      {
        availableAt: triageCase.createdAt,
        content: `${triageCase.ticket.title}\n\n${triageCase.ticket.description}`,
        provenance: "seeded",
        source: "case.ticket",
      },
    ],
    issue: {
      assignee: triageCase.asFiled?.assignee ?? null,
      labels: [...(triageCase.asFiled?.labels ?? [])],
      parent: triageCase.asFiled?.parent ?? null,
      priority: triageCase.asFiled?.priority ?? 0,
      project: triageCase.asFiled?.project ?? null,
      state: "Triage",
    },
    listMembershipUnknown: [],
    lists,
    memory: [],
    relations: [],
    replies: [],
    rootTurn: null,
    routeResults: [],
    routes: [],
    stamp,
    steps: 0,
    writes: [],
  };
}

/** Replay time moves one second per write from the case's creation, so versions rise. */
export const tick = (state: ReplayState) => {
  state.clock += 1;
  return new Date(
    Date.parse(state.case.createdAt) + state.clock * 1000
  ).toISOString();
};

/** A snapshot field's value as of the case, with `unknown` read as nothing known. */
export const asOfText = (value: string, fallback: string): string =>
  value === "unknown" ? fallback : value;
export const asOfName = (value: string | null): string | null =>
  value === "unknown" ? null : value;
export const asOfList = (value: string[] | "unknown"): string[] =>
  value === "unknown" ? [] : value;

export const isCase = (state: ReplayState, id: unknown) =>
  id === CASE_ISSUE_ID || id === state.case.id;

export const TEAM = { id: "8eaf95ab-56ac-4490-8253-f6a96793dc40" };
export const createdIssue = (state: ReplayState, id: unknown) =>
  state.created.find(
    (issue) => issue.identifier === id || issueIdOf(issue.identifier) === id
  );

export function asOfCase<L extends FrozenList>(
  state: ReplayState,
  list: L
): FrozenLists[L] {
  const items = state.lists[list] as FrozenLists[L];
  if (
    items.some((item) => item.createdAt === undefined) &&
    !state.listMembershipUnknown.includes(list)
  ) {
    state.listMembershipUnknown.push(list);
  }
  return items.filter(
    (item) =>
      item.createdAt !== undefined && item.createdAt < state.case.createdAt
  ) as FrozenLists[L];
}

export const usersMatching = (users: FrozenLists["users"], value: unknown) => {
  const wanted = String(value).toLowerCase();
  return users
    .filter(
      (item) =>
        item.email?.toLowerCase() === wanted ||
        item.name.toLowerCase() === wanted ||
        item.displayName?.toLowerCase() === wanted
    )
    .map(({ id, name }) => ({ id, name }));
};
