import { z } from "zod";
import type { LinearOperation } from "./linear-operations.js";

const named = z.looseObject({ id: z.string(), name: z.string() });
const nodes = <T extends z.ZodType>(item: T) =>
  z.looseObject({ nodes: z.array(item) });
const pageInfo = z.looseObject({
  endCursor: z.string().nullish(),
  hasNextPage: z.boolean(),
});
const document = z.looseObject({
  id: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});
const documentWrite = z.union([
  z.looseObject({ success: z.literal(false) }),
  z.looseObject({
    document: z.looseObject({ id: z.string(), url: z.string() }),
    success: z.literal(true),
  }),
]);
const confirmed = z.looseObject({ success: z.boolean() });
const responses = {
  CreateDocument: z.looseObject({ documentCreate: documentWrite }),
  Document: z.looseObject({ document }),
  IssueDocuments: z.looseObject({
    issue: z.looseObject({
      documents: nodes(z.looseObject({ id: z.string(), title: z.string() })),
      id: z.string(),
    }),
  }),
  Projects: z.looseObject({ projects: nodes(named) }),
  RelatedIssues: z.looseObject({
    issues: z.looseObject({
      nodes: z.array(
        z.looseObject({
          assignee: z.looseObject({ name: z.string() }).nullable(),
          createdAt: z.string(),
          id: z.string(),
          identifier: z.string(),
          labels: nodes(z.looseObject({ name: z.string() })),
          parent: z.looseObject({ identifier: z.string() }).nullable(),
          state: z.looseObject({ name: z.string(), type: z.string() }),
          title: z.string(),
          url: z.string(),
        })
      ),
      pageInfo,
    }),
  }),
  RouteAttachment: z.looseObject({ attachmentLinkURL: confirmed }),
  RouteIssue: z.looseObject({
    issue: z
      .looseObject({
        assignee: named.nullable(),
        id: z.string(),
        identifier: z.string(),
        labels: nodes(named),
        parent: z.looseObject({ identifier: z.string() }).nullable(),
        priority: z.number(),
        project: named.nullable(),
        state: z.looseObject({ name: z.string() }),
        team: z.looseObject({ id: z.string() }),
        url: z.string(),
      })
      .nullable(),
  }),
  RouteIssueUpdate: z.looseObject({ issueUpdate: confirmed }),
  RouteRelation: z.looseObject({ issueRelationCreate: confirmed }),
  TeamLabels: z.looseObject({ issueLabels: nodes(named).extend({ pageInfo }) }),
  UpdateDocument: z.looseObject({ documentUpdate: documentWrite }),
  Users: z.looseObject({ users: nodes(named) }),
  WorkflowStates: z.looseObject({ workflowStates: nodes(named) }),
} satisfies Record<LinearOperation, z.ZodType>;
const envelope = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
});

/** Validate only response fields the helpers consume; provider additions remain compatible. */
export function parseLinearResponse(
  operation: LinearOperation,
  value: unknown
): unknown {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) {
    throw new Error("Linear GraphQL returned an invalid response envelope.");
  }
  const body = parsed.data;
  if (body.errors?.length) {
    throw new Error(
      `Linear GraphQL error: ${body.errors.map((error) => error.message ?? "unknown error").join("; ")}`
    );
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL response carried no data.");
  }
  const data = responses[operation].safeParse(body.data);
  if (!data.success) {
    throw new Error(`Linear GraphQL returned invalid data for ${operation}.`);
  }
  return data.data;
}
