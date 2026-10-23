import { z } from "zod";
import {
  LINEAR_OPERATIONS,
  type LinearOperation,
} from "../linear-operations.js";
import { NEW_MASTER, type TriageCase } from "./schema.js";

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
type FrozenList = (typeof FROZEN_LISTS)[number];

interface StoredDocument {
  content: string;
  id: string;
  issueId: string;
  title: string;
  updatedAt: string;
}

interface IssueFields {
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

export interface ReplayState {
  /** The case's pinned repository archive in Blob; the only code the replay can read. */
  archive: { commit: string; url: string };
  calls: Record<string, { input: Record<string, unknown>; tool: string }>;
  /** Why the replay hook cancelled the run, or null. */
  cancelled: string | null;
  case: TriageCase;
  /** The cohort hash the runner verified when it started this replay; every result carries it. */
  cohortSha256: string;
  clock: number;
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
  steps: number;
  writes: { operation: string; seq: number; variables: unknown }[];
}

const CASE_ISSUE_ID = "replay-case";
const issueIdOf = (identifier: string) => `replay-${identifier}`;
const urlOf = (identifier: string) =>
  `https://linear.app/acquisity/issue/${identifier}/replay`;

/** A fresh store for one case: the ticket as created, no comments, no documents. */
export function seedReplayState(
  triageCase: TriageCase,
  lists: FrozenLists,
  archiveUrl: string,
  cohortSha256 = ""
): ReplayState {
  return {
    archive: { commit: triageCase.repoCommitAtCreate, url: archiveUrl },
    calls: {},
    cancelled: null,
    case: triageCase,
    cohortSha256,
    clock: 0,
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
      assignee: null,
      labels: [],
      parent: null,
      priority: 0,
      project: null,
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
    steps: 0,
    writes: [],
  };
}

/** Replay time moves one second per write from the case's creation, so versions rise. */
const tick = (state: ReplayState) => {
  state.clock += 1;
  return new Date(
    Date.parse(state.case.createdAt) + state.clock * 1000
  ).toISOString();
};

/** A snapshot field's value as of the case, with `unknown` read as nothing known. */
const asOfText = (value: string, fallback: string): string =>
  value === "unknown" ? fallback : value;
const asOfName = (value: string | null): string | null =>
  value === "unknown" ? null : value;
const asOfList = (value: string[] | "unknown"): string[] =>
  value === "unknown" ? [] : value;

const isCase = (state: ReplayState, id: unknown) =>
  id === CASE_ISSUE_ID || id === state.case.id;

const TEAM = { id: "8eaf95ab-56ac-4490-8253-f6a96793dc40" };
const CREATED_PREFIX = "REPLAY-";

const createdIssue = (state: ReplayState, id: unknown) =>
  state.created.find(
    (issue) => issue.identifier === id || issueIdOf(issue.identifier) === id
  );

function renderIssue(
  state: ReplayState,
  id: string,
  identifier: string,
  fields: IssueFields
) {
  const project = state.lists.projects.find((p) => p.name === fields.project);
  const assignee = state.lists.users.find((u) => u.name === fields.assignee);
  return {
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    id,
    identifier,
    labels: {
      nodes: fields.labels.map((name) => ({
        id: state.lists.labels.find((l) => l.name === name)?.id ?? name,
        name,
      })),
    },
    parent: fields.parent ? { identifier: fields.parent } : null,
    priority: fields.priority,
    project: project ? { id: project.id, name: project.name } : null,
    state: { name: fields.state },
    team: TEAM,
    url: urlOf(identifier),
  };
}

function routeIssue(state: ReplayState, id: unknown) {
  if (isCase(state, id)) {
    return renderIssue(state, CASE_ISSUE_ID, state.case.id, state.issue);
  }
  const created = createdIssue(state, id);
  if (created) {
    return renderIssue(
      state,
      issueIdOf(created.identifier),
      created.identifier,
      created.fields
    );
  }
  const related = state.case.relatedSnapshot.find(
    (r) => r.id === id || issueIdOf(r.id) === id
  );
  if (!related) {
    return null;
  }
  const assigneeName = asOfName(related.assignee);
  const parent = asOfName(related.parent);
  const assignee = assigneeName
    ? state.lists.users.find((u) => u.name === assigneeName)
    : undefined;
  return {
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    id: issueIdOf(related.id),
    identifier: related.id,
    labels: {
      nodes: asOfList(related.labels).map((name) => ({ id: name, name })),
    },
    parent: parent ? { identifier: parent } : null,
    priority: 0,
    project: null,
    state: { name: related.state },
    team: TEAM,
    url: urlOf(related.id),
  };
}

type Filter = Record<string, unknown>;

/** Evaluates the IssueFilter shapes findRelatedIssues builds, against a snapshot issue. */
function matches(
  filter: Filter,
  issue: { createdAt: string; description: string; title: string }
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const v = value as Filter;
    switch (key) {
      case "and":
        return (value as Filter[]).every((f) => matches(f, issue));
      case "or":
        return (value as Filter[]).some((f) => matches(f, issue));
      case "title":
      case "description": {
        const needle = String(v.containsIgnoreCase ?? "").toLowerCase();
        return issue[key].toLowerCase().includes(needle);
      }
      case "createdAt":
        return (
          (v.gte === undefined || issue.createdAt >= String(v.gte)) &&
          (v.lt === undefined || issue.createdAt < String(v.lt))
        );
      case "team":
        return true;
      default:
        // An unrecognized filter key matches nothing rather than everything.
        return false;
    }
  });
}

function relatedIssues(state: ReplayState, variables: Filter) {
  const filter = variables.filter as Filter;
  const nodes = state.case.relatedSnapshot
    .filter((r) => r.createdAt < state.case.createdAt)
    .filter((r) =>
      matches(filter, {
        createdAt: r.createdAt,
        description: asOfText(r.description, ""),
        title: asOfText(r.title, ""),
      })
    )
    .map((r) => {
      const assignee = asOfName(r.assignee);
      const parent = asOfName(r.parent);
      return {
        assignee: assignee ? { name: assignee } : null,
        createdAt: r.createdAt,
        id: issueIdOf(r.id),
        identifier: r.id,
        labels: { nodes: asOfList(r.labels).map((name) => ({ name })) },
        parent: parent ? { identifier: parent } : null,
        state: { name: r.state, type: "unknown" },
        title: r.title,
        url: urlOf(r.id),
      };
    });
  return {
    issues: { nodes, pageInfo: { endCursor: null, hasNextPage: false } },
  };
}

function asOfCase<L extends FrozenList>(
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

const byName = (list: { id: string; name: string }[], name: unknown) =>
  list
    .filter((item) => item.name.toLowerCase() === String(name).toLowerCase())
    .map(({ id, name: itemName }) => ({ id, name: itemName }));

const usersMatching = (users: FrozenLists["users"], value: unknown) => {
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

function saveDocument(
  state: ReplayState,
  id: string | null,
  input: Filter
): { document: { id: string; updatedAt: string; url: string }; success: true } {
  const updatedAt = tick(state);
  let doc = id ? state.documents.find((d) => d.id === id) : undefined;
  if (doc) {
    doc.content = String(input.content ?? doc.content);
    doc.updatedAt = updatedAt;
  } else {
    doc = {
      content: String(input.content ?? ""),
      id: `replay-doc-${state.documents.length + 1}`,
      issueId: CASE_ISSUE_ID,
      title: String(input.title ?? ""),
      updatedAt,
    };
    state.documents.push(doc);
  }
  return {
    document: {
      id: doc.id,
      updatedAt: doc.updatedAt,
      url: urlOf(state.case.id),
    },
    success: true,
  };
}

/** Applies a RouteIssueUpdate input to one issue's fields, resolving ids back to names. */
function applyUpdate(state: ReplayState, issue: IssueFields, input: Filter) {
  const nameOf = (list: { id: string; name: string }[], id: unknown) =>
    list.find((item) => item.id === id)?.name ?? null;
  if (input.stateId !== undefined) {
    issue.state =
      nameOf(state.lists.states, input.stateId) ?? String(input.stateId);
  }
  if (input.priority !== undefined) {
    issue.priority = Number(input.priority);
  }
  if (input.projectId !== undefined) {
    issue.project = nameOf(state.lists.projects, input.projectId);
  }
  if (input.assigneeId !== undefined) {
    issue.assignee = nameOf(state.lists.users, input.assigneeId);
  }
  if (Array.isArray(input.labelIds)) {
    issue.labels = input.labelIds.map(
      (id) => nameOf(state.lists.labels, id) ?? String(id)
    );
  }
  if (input.parentId !== undefined) {
    const parent = String(input.parentId);
    issue.parent = parent.startsWith("replay-") ? parent.slice(7) : parent;
  }
}

export class ReplayUnsupportedError extends Error {
  constructor(operation: string) {
    super(`Triage replay has no answer for ${operation}.`);
    this.name = "ReplayUnsupportedError";
  }
}

interface Answer {
  data: unknown;
  provenance: "seeded" | "generated";
}
type Handler = (state: ReplayState, variables: Filter) => Answer;

const seeded = (data: unknown): Answer => ({ data, provenance: "seeded" });
const generated = (data: unknown): Answer => ({
  data,
  provenance: "generated",
});

/** One answer per authored Linear operation; reads as the case was, writes into the store. */
const HANDLERS: Record<LinearOperation, Handler> = {
  CreateDocument: (state, v) =>
    generated({ documentCreate: saveDocument(state, null, v.input as Filter) }),
  Document: (state, v) => {
    const doc = state.documents.find((d) => d.id === v.id);
    return generated({
      document: doc
        ? { id: doc.id, updatedAt: doc.updatedAt, url: urlOf(state.case.id) }
        : null,
    });
  },
  IssueDocuments: (state, v) =>
    generated({
      issue: {
        documents: {
          nodes: state.documents
            .filter((d) => d.title === v.title)
            .map(({ id, title }) => ({ id, title })),
        },
        id: CASE_ISSUE_ID,
        identifier: state.case.id,
      },
    }),
  Projects: (state, v) =>
    seeded({
      projects: { nodes: byName(asOfCase(state, "projects"), v.name) },
    }),
  RelatedIssues: (state, v) => seeded(relatedIssues(state, v)),
  RouteAttachment: () => generated({ attachmentLinkURL: { success: true } }),
  RouteIssue: (state, v) => {
    const answer = { issue: routeIssue(state, v.id) };
    // The case ticket read back after routing shows this replay's own writes.
    return (isCase(state, v.id) && state.routes.length > 0) ||
      createdIssue(state, v.id)
      ? generated(answer)
      : seeded(answer);
  },
  RouteIssueUpdate: (state, v) => {
    if (isCase(state, v.id)) {
      applyUpdate(state, state.issue, v.input as Filter);
      state.routes.push({
        input: v.input as Record<string, unknown>,
        seq: state.writes.length,
      });
    }
    const created = createdIssue(state, v.id);
    if (created) {
      applyUpdate(state, created.fields, v.input as Filter);
    }
    return generated({ issueUpdate: { success: true } });
  },
  RouteRelation: (state, v) => {
    const input = v.input as Filter;
    state.relations.push({
      issueId: String(input.issueId ?? ""),
      relatedIssueId: String(input.relatedIssueId ?? ""),
      type: String(input.type ?? ""),
    });
    return generated({ issueRelationCreate: { success: true } });
  },
  TeamLabels: (state) =>
    seeded({
      issueLabels: {
        nodes: asOfCase(state, "labels").map(({ id, name }) => ({ id, name })),
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
  UpdateDocument: (state, v) =>
    generated({
      documentUpdate: saveDocument(state, String(v.id), v.input as Filter),
    }),
  Users: (state, v) =>
    seeded({
      users: { nodes: usersMatching(asOfCase(state, "users"), v.name) },
    }),
  WorkflowStates: (state, v) =>
    seeded({
      workflowStates: { nodes: byName(asOfCase(state, "states"), v.name) },
    }),
};

/**
 * Answers one authored Linear operation against the store. Mutates `state`
 * for writes. Returns the GraphQL `data` payload the real API would.
 */
export function answerLinear(
  state: ReplayState,
  operation: LinearOperation,
  variables: Filter
): Answer {
  const handler = HANDLERS[operation];
  if (!handler) {
    throw new ReplayUnsupportedError(`linear.${String(operation)}`);
  }
  if (LINEAR_OPERATIONS[operation].kind === "mutation") {
    state.writes.push({ operation, seq: state.writes.length + 1, variables });
  }
  return handler(state, variables);
}

const identifierOf = (state: ReplayState, id: string) => {
  if (id === CASE_ISSUE_ID) {
    return state.case.id;
  }
  return id.startsWith("replay-") ? id.slice(7) : id;
};

const masterOf = (state: ReplayState, duplicate: string | undefined) => {
  if (state.issue.parent) {
    return createdIssue(state, state.issue.parent)
      ? NEW_MASTER
      : state.issue.parent;
  }
  if (!duplicate) {
    return null;
  }
  const target = state.case.relatedSnapshot.find((r) => r.id === duplicate);
  return (target && asOfName(target.parent)) ?? duplicate;
};

export function appliedRoute(state: ReplayState) {
  const duplicates = [
    ...new Set(
      state.relations
        .filter(
          (relation) =>
            relation.type === "duplicate" && isCase(state, relation.issueId)
        )
        .map((relation) => identifierOf(state, relation.relatedIssueId))
    ),
  ];
  return {
    applied: state.routes.length > 0 || duplicates.length > 0,
    assignee: state.issue.assignee,
    duplicateOf: duplicates.length > 0 ? duplicates.join(",") : null,
    master: masterOf(state, duplicates[0]),
    project: state.issue.project,
  };
}

export const ROOT_CAUSE_GROUP = "Root Cause";

const openAt = (project: FrozenLists["projects"][number], moment: string) =>
  !(
    (project.completedAt && project.completedAt < moment) ||
    (project.canceledAt && project.canceledAt < moment)
  );

export function replayCatalog(state: ReplayState) {
  const moment = state.case.createdAt;
  return {
    projects: asOfCase(state, "projects")
      .filter((project) => openAt(project, moment))
      .map((project) => ({ name: project.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    rootCauseLabels: asOfCase(state, "labels")
      .filter((label) => label.group === ROOT_CAUSE_GROUP)
      .map((label) => label.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

/** The text of a document this replay wrote, for the critic's read. */
export function replayDocumentText(
  state: ReplayState,
  id: string
): { content: string; updatedAt: string } | null {
  const doc = state.documents.find((d) => d.id === id);
  return doc ? { content: doc.content, updatedAt: doc.updatedAt } : null;
}

const issueText = (fields: IssueFields) => ({
  assignee: fields.assignee,
  labels: fields.labels,
  parent: fields.parent,
  priority: fields.priority,
  project: fields.project,
  state: fields.state,
});

export function replayIssueView(
  state: ReplayState,
  identifier: string
): { generated: unknown; seeded: unknown } | null {
  const comments = state.comments
    .filter((comment) => comment.issue === identifier)
    .map((comment) => comment.body);
  if (isCase(state, identifier)) {
    return {
      generated: { comments, fields: issueText(state.issue) },
      seeded: {
        attachmentKinds: state.case.ticket.attachmentKinds,
        createdAt: state.case.createdAt,
        description: state.case.ticket.description,
        identifier: state.case.id,
        title: state.case.ticket.title,
      },
    };
  }
  const created = createdIssue(state, identifier);
  if (created) {
    return {
      generated: {
        comments,
        description: created.description,
        fields: issueText(created.fields),
        identifier: created.identifier,
        title: created.title,
      },
      seeded: null,
    };
  }
  const related = state.case.relatedSnapshot.find((r) => r.id === identifier);
  if (!related) {
    return null;
  }
  return {
    generated: comments.length > 0 ? { comments } : null,
    seeded: related,
  };
}

export function addReplayComment(
  state: ReplayState,
  issue: string,
  body: string
): boolean {
  if (!replayIssueView(state, issue)) {
    return false;
  }
  state.comments.push({ body, issue });
  tick(state);
  return true;
}

export function createReplayIssue(
  state: ReplayState,
  input: {
    assignee?: string;
    description: string;
    labels?: string[];
    parent?: string;
    priority?: number;
    project?: string;
    title: string;
  }
): string {
  const identifier = `${CREATED_PREFIX}${state.created.length + 1}`;
  state.created.push({
    description: input.description,
    fields: {
      assignee:
        input.assignee === undefined
          ? null
          : (usersMatching(asOfCase(state, "users"), input.assignee)[0]?.name ??
            null),
      labels: input.labels ?? [],
      parent: input.parent ?? null,
      priority: input.priority ?? 0,
      project: input.project ?? null,
      state: "Todo",
    },
    identifier,
    title: input.title,
  });
  tick(state);
  return identifier;
}
