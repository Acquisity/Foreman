import assert from "node:assert/strict";
import type { ProviderClient } from "./executor/operations.js";

/** Linear stand-ins for route_ticket tests. */

export const json = (body: unknown) =>
  Promise.resolve({ data: body, status: 200 });

export interface Call {
  query: string;
  variables: Record<string, unknown>;
}

export const MISSING_RELATION = "missing duplicate relation";

/** An extra issue; `master` gives it the master template's Regression seam section. */
export interface FakeIssue {
  assignee?: { id: string; name: string };
  createdAt?: string;
  labels?: string[];
  master?: boolean;
  parent?: string;
}

/** The default master ENG-9, whose RouteIssue id is i-9. */
const DEFAULT_MASTER: [string, string, FakeIssue] = [
  "ENG-9",
  "i-9",
  { master: true },
];

const renderIssue = (id: string, issue: FakeIssue) => ({
  assignee: issue.assignee ?? null,
  id: `i-${id}`,
  identifier: id,
  labels: {
    nodes: (issue.labels ?? []).map((name) => ({ id: `l-${name}`, name })),
  },
  parent: issue.parent ? { identifier: issue.parent } : null,
  priority: 0,
  project: null,
  state: { name: "Triage" },
  team: { id: "t-eng" },
  url: `https://linear.app/acquisity/issue/${id}`,
});

/** The one RelatedIssues read route_ticket makes: an issue by id, for its creation time. */
/** The RouteIssue id of an issue: the default master ENG-9 is i-9. */
const fakeId = (identifier: string) =>
  identifier === DEFAULT_MASTER[0] ? DEFAULT_MASTER[1] : `i-${identifier}`;

/**
 * The RelatedIssues reads route_ticket makes: an issue by id (with the master
 * marker when the filter asks for it), or the children of a parent by id.
 */
const relatedById = (
  variables: Record<string, unknown>,
  issues: Record<string, FakeIssue>
) => {
  const filter = variables.filter as {
    description?: { contains?: string };
    id?: { eq?: string };
    parent?: { id?: { eq?: string } };
  };
  const all = [
    DEFAULT_MASTER,
    ...Object.entries(issues).map(
      ([identifier, issue]) => [identifier, fakeId(identifier), issue] as const
    ),
  ];
  const parentId = filter.parent?.id?.eq;
  const nodes = all
    .filter(([, issueId, issue]) =>
      parentId === undefined
        ? issueId === filter.id?.eq &&
          (filter.description === undefined || issue.master)
        : issue.parent !== undefined && fakeId(issue.parent) === parentId
    )
    .map(([identifier, issueId, issue]) => ({
      assignee: issue.assignee ? { name: issue.assignee.name } : null,
      createdAt: issue.createdAt ?? "2026-10-20T00:00:00.000Z",
      id: issueId,
      identifier,
      labels: { nodes: (issue.labels ?? []).map((name) => ({ name })) },
      parent: issue.parent ? { identifier: issue.parent } : null,
      state: { name: "Triage", type: "triage" },
      title: identifier,
      url: `https://linear.app/acquisity/issue/${identifier}`,
    }));
  return { nodes, pageInfo: { endCursor: null, hasNextPage: false } };
};

/** ENG-1 (Bug label, unassigned) and master ENG-9 (assigned to Anuj), plus any extra issues. */
const labelsFor = (
  master: boolean,
  readBack: boolean,
  ticketLabels?: { id: string; name: string }[]
) => {
  if (master) {
    return [];
  }
  if (ticketLabels) {
    return ticketLabels;
  }
  return readBack
    ? [
        { id: "l-bug", name: "Bug" },
        { id: "l-cr", name: "Customer reported" },
      ]
    : [{ id: "l-bug", name: "Bug" }];
};

export const fakeLinear = ({
  issues = {},
  masterAssignee = { id: "u-anuj", name: "Anuj Bhatt" },
  readBackFails = false,
  relationFails = false,
  updateFailures = 0,
  teamLabels = [],
  ticketAssignee = null,
  ticketLabels,
}: {
  issues?: Record<string, FakeIssue>;
  masterAssignee?: { id: string; name: string };
  readBackFails?: boolean;
  relationFails?: boolean;
  /** How many issue updates fail before one lands. */
  updateFailures?: number;
  teamLabels?: { id: string; name: string }[];
  ticketAssignee?: { id: string; name: string } | null;
  ticketLabels?: { id: string; name: string }[];
} = {}) => {
  const calls: Call[] = [];
  const relations: string[] = [];
  let failedUpdates = 0;
  type Vars = Record<string, unknown>;
  const routeIssue = (variables: Vars) => {
    if (variables.id === "ENG-999999") {
      return json({ data: { issue: null } });
    }
    const extra = issues[String(variables.id)];
    if (extra) {
      return json({
        data: { issue: renderIssue(String(variables.id), extra) },
      });
    }
    const master = variables.id === "ENG-9";
    // A read of ENG-1 after any write is the read-back.
    const readBack =
      !master &&
      calls.some((c) =>
        [
          "linear.RouteIssueUpdate",
          "linear.RouteRelation",
          "linear.RouteAttachment",
        ].includes(c.query)
      );
    if (readBack && readBackFails) {
      return json({ errors: [{ message: "Linear is busy" }] });
    }
    return json({
      data: {
        issue: {
          assignee: master || readBack ? masterAssignee : ticketAssignee,
          id: master ? "i-9" : "i-1",
          identifier: variables.id,
          labels: { nodes: labelsFor(master, readBack, ticketLabels) },
          parent: null,
          priority: readBack ? 3 : 0,
          project: readBack ? { id: "p-support", name: "Support" } : null,
          state: { name: readBack ? "Done" : "Triage" },
          team: { id: "t-eng" },
          url: `https://linear.app/acquisity/issue/${variables.id}`,
        },
      },
    });
  };
  const handlers: Record<string, (variables: Vars) => ReturnType<typeof json>> =
    {
      "linear.Projects": (variables) => {
        assert.equal(variables.teamId, "t-eng");
        return json({
          data: { projects: { nodes: [{ id: "p-support", name: "Support" }] } },
        });
      },
      "linear.RelatedIssues": (variables) =>
        json({ data: { issues: relatedById(variables, issues) } }),
      "linear.RouteAttachment": (variables) =>
        String(variables.url).includes("broken")
          ? json({ errors: [{ message: "Unable to fetch url information" }] })
          : json({ data: { attachmentLinkURL: { success: true } } }),
      "linear.RouteIssue": routeIssue,
      // Linear refuses the Duplicate state until the duplicate relation
      // exists, and then writes nothing (ENG-15734, ENG-15935, ENG-15785).
      "linear.RouteIssueUpdate": (variables) => {
        if (
          (variables.input as Vars).stateId === "s-duplicate" &&
          !relations.some((r) => r.startsWith(`${variables.id}>`))
        ) {
          return json({ errors: [{ message: MISSING_RELATION }] });
        }
        if (failedUpdates < updateFailures) {
          failedUpdates += 1;
          return json({ errors: [{ message: "Linear is busy" }] });
        }
        return json({ data: { issueUpdate: { success: true } } });
      },
      "linear.RouteRelation": (variables) => {
        if (!relationFails) {
          const input = variables.input as Record<string, string>;
          relations.push(`${input.issueId}>${input.relatedIssueId}`);
        }
        return json({
          data: { issueRelationCreate: { success: !relationFails } },
        });
      },
      // Two pages: the second carries the label the union needs.
      "linear.TeamLabels": (variables) =>
        json({
          data: {
            issueLabels:
              variables.after === null
                ? {
                    nodes: [{ id: "l-bug", name: "Bug" }],
                    pageInfo: { endCursor: "lc1", hasNextPage: true },
                  }
                : {
                    nodes: [
                      { id: "l-cr", name: "Customer reported" },
                      ...teamLabels,
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
          },
        }),
      "linear.Users": () =>
        json({
          data: {
            users: { nodes: [{ id: "u-ebu", name: "Ebubeker Rexha" }] },
          },
        }),
      "linear.WorkflowStates": (variables) => {
        const stateName = String(variables.name);
        return json({
          data: {
            workflowStates: {
              nodes: [{ id: `s-${stateName.toLowerCase()}`, name: stateName }],
            },
          },
        });
      },
    };
  const fetchStub: ProviderClient = (request) => {
    const body = {
      query: request.operation,
      variables: "variables" in request.input ? request.input.variables : {},
    } as Call;
    calls.push(body);
    const handle = handlers[body.query];
    if (!handle) {
      throw new Error(`Unexpected query: ${body.query.slice(0, 40)}`);
    }
    return handle(body.variables);
  };
  const updates = () =>
    calls.filter((c) => c.query === "linear.RouteIssueUpdate");
  const writes = () =>
    calls
      .map((c) => c.query)
      .filter((query) =>
        ["linear.RouteRelation", "linear.RouteIssueUpdate"].includes(query)
      );
  return { calls, fetchStub, relations, updates, writes };
};
