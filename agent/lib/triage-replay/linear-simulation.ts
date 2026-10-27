import type { LinearOperation } from "../linear-operations.js";
import {
  asOfCase,
  asOfList,
  asOfName,
  asOfText,
  CASE_ISSUE_ID,
  createdIssue,
  type IssueFields,
  isCase,
  issueIdOf,
  type ReplayState,
  team,
  tick,
  urlOf,
  usersMatching,
} from "./store.js";

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
    team: team(),
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
    team: team(),
    url: urlOf(related.id),
  };
}

type Filter = Record<string, unknown>;

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

const byName = (list: { id: string; name: string }[], name: unknown) =>
  list
    .filter((item) => item.name.toLowerCase() === String(name).toLowerCase())
    .map(({ id, name: itemName }) => ({ id, name: itemName }));

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

type Handler = (state: ReplayState, variables: Filter) => unknown;

const HANDLERS: Record<LinearOperation, Handler> = {
  CreateDocument: (state, v) => ({
    documentCreate: saveDocument(state, null, v.input as Filter),
  }),
  Document: (state, v) => {
    const doc = state.documents.find((d) => d.id === v.id);
    return {
      document: doc
        ? { id: doc.id, updatedAt: doc.updatedAt, url: urlOf(state.case.id) }
        : null,
    };
  },
  IssueDocuments: (state, v) => ({
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
  Projects: (state, v) => ({
    projects: { nodes: byName(asOfCase(state, "projects"), v.name) },
  }),
  RelatedIssues: (state, v) => relatedIssues(state, v),
  RouteAttachment: () => ({ attachmentLinkURL: { success: true } }),
  RouteIssue: (state, v) => ({ issue: routeIssue(state, v.id) }),
  RouteIssueUpdate: (state, v) => {
    if (isCase(state, v.id)) {
      applyUpdate(state, state.issue, v.input as Filter);
      state.routes.push(v.input as Record<string, unknown>);
    }
    const created = createdIssue(state, v.id);
    if (created) {
      applyUpdate(state, created.fields, v.input as Filter);
    }
    return { issueUpdate: { success: true } };
  },
  RouteRelation: (state, v) => {
    const input = v.input as Filter;
    state.relations.push({
      issueId: String(input.issueId ?? ""),
      relatedIssueId: String(input.relatedIssueId ?? ""),
      type: String(input.type ?? ""),
    });
    return { issueRelationCreate: { success: true } };
  },
  TeamLabels: (state) => ({
    issueLabels: {
      nodes: asOfCase(state, "labels").map(({ id, name }) => ({ id, name })),
      pageInfo: { endCursor: null, hasNextPage: false },
    },
  }),
  UpdateDocument: (state, v) => ({
    documentUpdate: saveDocument(state, String(v.id), v.input as Filter),
  }),
  Users: (state, v) => ({
    users: { nodes: usersMatching(asOfCase(state, "users"), v.name) },
  }),
  WorkflowStates: (state, v) => ({
    workflowStates: { nodes: byName(asOfCase(state, "states"), v.name) },
  }),
};

export function answerLinear(
  state: ReplayState,
  operation: LinearOperation,
  variables: Filter
): unknown {
  const handler = HANDLERS[operation];
  if (!handler) {
    throw new Error(`Triage replay has no answer for linear.${operation}.`);
  }
  return handler(state, variables);
}
