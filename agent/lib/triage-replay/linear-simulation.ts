import type { LinearOperation } from "../linear-operations.js";
import {
  asOfCase,
  asOfList,
  asOfName,
  asOfText,
  CASE_ISSUE_ID,
  createdIssue,
  documentUrlOf,
  type IssueFields,
  isCase,
  issueIdOf,
  parentAsOfRun,
  type ReplayState,
  relatedAsOfCase,
  snapshotAsOfCase,
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
  const related = relatedAsOfCase(state, id);
  if (!related) {
    return null;
  }
  const assigneeName = asOfName(related.assignee);
  const parent = asOfName(parentAsOfRun(state, related.id, related.parent));
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
  issue: {
    createdAt: string;
    description: string;
    id: string;
    parent: string | null;
    title: string;
  }
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const v = value as Filter;
    switch (key) {
      case "and":
        return (value as Filter[]).every((f) => matches(f, issue));
      case "or":
        return (value as Filter[]).some((f) => matches(f, issue));
      case "title":
      case "description":
        return v.contains === undefined
          ? issue[key]
              .toLowerCase()
              .includes(String(v.containsIgnoreCase ?? "").toLowerCase())
          : issue[key].includes(String(v.contains));
      case "createdAt":
        return (
          (v.gte === undefined || issue.createdAt >= String(v.gte)) &&
          (v.lt === undefined || issue.createdAt < String(v.lt))
        );
      case "team":
        return true;
      case "id":
        return v.eq === issue.id;
      case "parent":
        return (
          issue.parent !== null &&
          (v.id as Filter | undefined)?.eq === issueIdOf(issue.parent)
        );
      default:
        return false;
    }
  });
}

/**
 * For a "children of this issue" read, the case ticket and the issues the run
 * created whose parent (as the run set it) is that issue: live Linear counts
 * them, and the snapshot holds neither.
 */
function childrenBeyondSnapshot(state: ReplayState, filter: Filter) {
  if (filter.parent === undefined) {
    return [];
  }
  const parentId = ((filter.parent as Filter).id as Filter | undefined)?.eq;
  return [{ fields: state.issue, identifier: state.case.id }, ...state.created]
    .filter(
      ({ fields }) =>
        fields.parent !== null && issueIdOf(fields.parent) === parentId
    )
    .map(({ identifier }) => ({
      ...routeIssue(state, identifier),
      createdAt: state.case.createdAt,
      state: { name: "Todo", type: "unknown" },
      title: identifier,
    }));
}

function relatedIssues(state: ReplayState, variables: Filter) {
  const filter = variables.filter as Filter;
  // route_ticket reads a master by id for its creation time; a master this
  // run created is as new as the case.
  const created = createdIssue(state, (filter.id as Filter | undefined)?.eq);
  if (
    created &&
    matches(filter, {
      createdAt: state.case.createdAt,
      description: created.description,
      id: issueIdOf(created.identifier),
      parent: created.fields.parent,
      title: created.title,
    })
  ) {
    return {
      issues: {
        nodes: [
          {
            ...routeIssue(state, created.identifier),
            createdAt: state.case.createdAt,
            state: { name: created.fields.state, type: "unknown" },
            title: created.identifier,
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    };
  }
  const nodes = snapshotAsOfCase(state)
    .filter((r) =>
      matches(filter, {
        createdAt: r.createdAt,
        description: asOfText(r.description, ""),
        id: issueIdOf(r.id),
        parent: asOfName(parentAsOfRun(state, r.id, r.parent)),
        title: asOfText(r.title, ""),
      })
    )
    .map((r) => {
      const assignee = asOfName(r.assignee);
      const parent = asOfName(parentAsOfRun(state, r.id, r.parent));
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
    issues: {
      nodes: [...nodes, ...childrenBeyondSnapshot(state, filter)],
      pageInfo: { endCursor: null, hasNextPage: false },
    },
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
      url: documentUrlOf(doc.id),
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

/**
 * A parent set on an existing snapshot issue, such as a lone report moved
 * under the master this run created; its other fields stay as frozen.
 */
function reparentSnapshot(state: ReplayState, id: unknown, input: Filter) {
  const identifier = String(id).startsWith("replay-")
    ? String(id).slice(7)
    : String(id);
  if (
    input.parentId === undefined ||
    isCase(state, id) ||
    createdIssue(state, id) ||
    !relatedAsOfCase(state, identifier)
  ) {
    return;
  }
  const parent = String(input.parentId);
  state.reparented = {
    ...state.reparented,
    [identifier]: parent.startsWith("replay-") ? parent.slice(7) : parent,
  };
}

type Handler = (state: ReplayState, variables: Filter) => unknown;

function caseDocumentsOnly(state: ReplayState, issue: unknown) {
  if (!isCase(state, issue)) {
    throw new Error(
      `Triage replay keeps documents only on ${state.case.id}, not ${String(issue)}.`
    );
  }
}

const HANDLERS: Record<LinearOperation, Handler> = {
  CreateDocument: (state, v) => {
    const input = v.input as Filter;
    caseDocumentsOnly(state, input.issueId);
    return { documentCreate: saveDocument(state, null, input) };
  },
  Document: (state, v) => {
    const doc = state.documents.find((d) => d.id === v.id);
    return {
      document: doc
        ? { id: doc.id, updatedAt: doc.updatedAt, url: documentUrlOf(doc.id) }
        : null,
    };
  },
  // Only the dispute evidence tool reads ticket bodies; triage never does.
  IssueBodies: () => ({ issues: { nodes: [] } }),
  IssueDocuments: (state, v) => {
    caseDocumentsOnly(state, v.id);
    return {
      issue: {
        documents: {
          nodes: state.documents
            .filter((d) => d.title === v.title)
            .map(({ id, title }) => ({ id, title })),
        },
        id: CASE_ISSUE_ID,
        identifier: state.case.id,
      },
    };
  },
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
    reparentSnapshot(state, v.id, v.input as Filter);
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
