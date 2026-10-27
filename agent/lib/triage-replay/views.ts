import { NEW_MASTER } from "./schema.js";
import {
  asOfCase,
  asOfName,
  CASE_ISSUE_ID,
  createdIssue,
  type FrozenLists,
  type IssueFields,
  isCase,
  type ReplayState,
  tick,
  usersMatching,
} from "./store.js";

const CREATED_PREFIX = "REPLAY-";

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
): { issue: unknown; replay: unknown } | null {
  const comments = state.comments
    .filter((comment) => comment.issue === identifier)
    .map((comment) => comment.body);
  if (isCase(state, identifier)) {
    return {
      issue: {
        attachmentKinds: state.case.ticket.attachmentKinds,
        createdAt: state.case.createdAt,
        description: state.case.ticket.description,
        identifier: state.case.id,
        title: state.case.ticket.title,
      },
      replay: { comments, fields: issueText(state.issue) },
    };
  }
  const created = createdIssue(state, identifier);
  if (created) {
    return {
      issue: null,
      replay: {
        comments,
        description: created.description,
        fields: issueText(created.fields),
        identifier: created.identifier,
        title: created.title,
      },
    };
  }
  const related = state.case.relatedSnapshot.find((r) => r.id === identifier);
  if (!related) {
    return null;
  }
  return {
    issue: related,
    replay: comments.length > 0 ? { comments } : null,
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
