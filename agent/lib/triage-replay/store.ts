import { z } from "zod";
import { ENGINEERING_TEAM_ID } from "../linear-api.js";
import { ticketUrl } from "../ticket-links.js";
import type {
  CriticPacket,
  CriticRounds,
  CriticVerdictFields,
} from "../triage-log.js";
import type { TriageCase } from "./schema.js";

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
type FrozenList = keyof FrozenLists;

interface StoredDocument {
  content: string;
  id: string;
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

interface CreatedIssue {
  description: string;
  fields: IssueFields;
  identifier: string;
  title: string;
}

export interface ReplayState {
  archive: { commit: string; url: string };
  case: TriageCase;
  caseKey: string;
  clock: number;
  comments: { body: string; issue: string }[];
  created: CreatedIssue[];
  critic: CriticVerdictFields | null;
  criticCalls?: string[];
  criticObjections?: number;
  criticPackets?: Record<string, CriticPacket>;
  criticRounds?: Record<string, CriticRounds>;
  decisions: { kind: "billing" | "triage"; output: unknown }[];
  documents: StoredDocument[];
  evidenceMisses: string[];
  issue: IssueFields;
  lists: FrozenLists;
  relations: { issueId: string; relatedIssueId: string; type: string }[];
  rootTurn: "completed" | "failed" | "cancelled" | null;
  routes: Record<string, unknown>[];
  stamp: { foremanCommit: string; startedAt: string };
}

export const CASE_ISSUE_ID = "replay-case";
export const issueIdOf = (identifier: string) => `replay-${identifier}`;
export const urlOf = (identifier: string) => `${ticketUrl(identifier)}/replay`;

export function seedReplayState(
  triageCase: TriageCase,
  options: {
    archiveUrl: string;
    caseKey: string;
    lists: FrozenLists;
    stamp: ReplayState["stamp"];
  }
): ReplayState {
  return {
    archive: { commit: triageCase.repoCommitAtCreate, url: options.archiveUrl },
    case: triageCase,
    caseKey: options.caseKey,
    clock: 0,
    comments: [],
    created: [],
    critic: null,
    decisions: [],
    documents: [],
    evidenceMisses: [],
    issue: {
      assignee: triageCase.asFiled?.assignee ?? null,
      labels: [...(triageCase.asFiled?.labels ?? [])],
      parent: triageCase.asFiled?.parent ?? null,
      priority: triageCase.asFiled?.priority ?? 0,
      project: triageCase.asFiled?.project ?? null,
      state: "Triage",
    },
    lists: options.lists,
    relations: [],
    rootTurn: null,
    routes: [],
    stamp: options.stamp,
  };
}

export const tick = (state: ReplayState) => {
  state.clock += 1;
  return new Date(
    Date.parse(state.case.createdAt) + state.clock * 1000
  ).toISOString();
};

export const asOfText = (value: string, fallback: string): string =>
  value === "unknown" ? fallback : value;
export const asOfName = (value: string | null): string | null =>
  value === "unknown" ? null : value;
export const asOfList = (value: string[] | "unknown"): string[] =>
  value === "unknown" ? [] : value;

export const isCase = (state: ReplayState, id: unknown) =>
  id === CASE_ISSUE_ID || id === state.case.id;

export const snapshotAsOfCase = (state: ReplayState) =>
  state.case.relatedSnapshot.filter(
    (related) => related.createdAt < state.case.createdAt
  );

export const relatedAsOfCase = (state: ReplayState, id: unknown) =>
  snapshotAsOfCase(state).find(
    (related) => related.id === id || issueIdOf(related.id) === id
  );

export const team = () => ({ id: ENGINEERING_TEAM_ID });
export const createdIssue = (state: ReplayState, id: unknown) =>
  state.created.find(
    (issue) => issue.identifier === id || issueIdOf(issue.identifier) === id
  );

export const asOfCase = <L extends FrozenList>(
  state: ReplayState,
  list: L
): FrozenLists[L] =>
  (state.lists[list] as FrozenLists[L]).filter(
    (item) =>
      item.createdAt !== undefined && item.createdAt < state.case.createdAt
  ) as FrozenLists[L];

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
