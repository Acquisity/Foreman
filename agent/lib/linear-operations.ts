/** Canonical authored GraphQL documents used by helpers and Executor specs. */
export const LINEAR_OPERATIONS = {
  CreateDocument: {
    document: `mutation CreateDocument($input: DocumentCreateInput!) {
  documentCreate(input: $input) { success document { id updatedAt url } }
}`,
    kind: "mutation",
  },
  Document: {
    document: `query Document($id: String!) {
  document(id: $id) { id updatedAt url }
}`,
    kind: "query",
  },
  IssueDocuments: {
    document: `query IssueDocuments($id: String!, $title: String!) {
  issue(id: $id) {
    id identifier
    documents(filter: { title: { eq: $title } }, first: 50) { nodes { id title } }
  }
}`,
    kind: "query",
  },
  Projects: {
    document: `query Projects($name: String!, $teamId: ID!) {
  projects(first: 5, filter: { name: { eqIgnoreCase: $name }, accessibleTeams: { some: { id: { eq: $teamId } } } }) {
    nodes { id name }
  }
}`,
    kind: "query",
  },
  RelatedIssues: {
    document: `query RelatedIssues($filter: IssueFilter!, $first: Int!, $after: String, $includeArchived: Boolean!) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: createdAt) {
    nodes {
      id identifier title url createdAt
      state { name type }
      assignee { name }
      parent { identifier }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
    kind: "query",
  },
  RouteAttachment: {
    document: `mutation RouteAttachment($issueId: String!, $url: String!, $title: String!) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`,
    kind: "mutation",
  },
  RouteIssue: {
    document: `query RouteIssue($id: String!) {
  issue(id: $id) {
    id identifier url priority
    team { id }
    state { name }
    labels { nodes { id name } }
    project { id name }
    assignee { id name }
    parent { identifier }
  }
}`,
    kind: "query",
  },
  RouteIssueUpdate: {
    document: `mutation RouteIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`,
    kind: "mutation",
  },
  RouteRelation: {
    document: `mutation RouteRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`,
    kind: "mutation",
  },
  TeamLabels: {
    document: `query TeamLabels($teamId: ID!, $after: String) {
  issueLabels(first: 250, after: $after, filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`,
    kind: "query",
  },
  UpdateDocument: {
    document: `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) { success document { id updatedAt url } }
}`,
    kind: "mutation",
  },
  Users: {
    document: `query Users($name: String!) {
  users(first: 5, filter: { or: [{ email: { eq: $name } }, { name: { eqIgnoreCase: $name } }, { displayName: { eqIgnoreCase: $name } }] }) {
    nodes { id name }
  }
}`,
    kind: "query",
  },
  WorkflowStates: {
    document: `query WorkflowStates($teamId: ID!, $name: String!) {
  workflowStates(first: 5, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name }
  }
}`,
    kind: "query",
  },
} as const;
export type LinearOperation = keyof typeof LINEAR_OPERATIONS;
