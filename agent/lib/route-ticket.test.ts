import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderClient } from "./executor/operations.js";
import { routeTicket } from "./linear-api.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";

const { default: tool } = await import("../tools/route_ticket.js");

const UNABLE_TO_FETCH = /Unable to fetch url information/u;
const NO_ISSUE = /No issue ENG-999999/u;
const UNKNOWN_LABEL =
  /Unknown label "Nope"\. Valid labels: Bug, Customer reported/u;

const json = (body: unknown) => Promise.resolve({ data: body, status: 200 });

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/** A Linear stand-in: ENG-1 (Bug label, unassigned) and master ENG-9 (assigned to Anuj). */
const READ_BACK_FAILED = /could not be read back/u;
const BEFORE_ROUTING = /before routing/u;
const LINEAR_BUSY = /Linear is busy/u;
const NOTHING_WRITTEN = /Nothing was written/u;

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

const fakeLinear = ({
  masterAssignee = { id: "u-anuj", name: "Anuj Bhatt" },
  readBackFails = false,
  teamLabels = [],
  ticketAssignee = null,
  ticketLabels,
}: {
  masterAssignee?: { id: string; name: string };
  readBackFails?: boolean;
  teamLabels?: { id: string; name: string }[];
  ticketAssignee?: { id: string; name: string } | null;
  ticketLabels?: { id: string; name: string }[];
} = {}) => {
  const calls: Call[] = [];
  const fetchStub: ProviderClient = (request) => {
    const body = {
      query: request.operation,
      variables: "variables" in request.input ? request.input.variables : {},
    } as Call;
    calls.push(body);
    const q = body.query;
    if (q === "linear.RouteIssue") {
      if (body.variables.id === "ENG-999999") {
        return json({ data: { issue: null } });
      }
      const master = body.variables.id === "ENG-9";
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
            identifier: body.variables.id,
            labels: { nodes: labelsFor(master, readBack, ticketLabels) },
            parent: null,
            priority: readBack ? 3 : 0,
            project: readBack ? { id: "p-support", name: "Support" } : null,
            state: { name: readBack ? "Done" : "Triage" },
            team: { id: "t-eng" },
            url: `https://linear.app/acquisity/issue/${body.variables.id}`,
          },
        },
      });
    }
    if (q === "linear.TeamLabels") {
      // Two pages: the second carries the label the union needs.
      return body.variables.after === null
        ? json({
            data: {
              issueLabels: {
                nodes: [{ id: "l-bug", name: "Bug" }],
                pageInfo: { endCursor: "lc1", hasNextPage: true },
              },
            },
          })
        : json({
            data: {
              issueLabels: {
                nodes: [
                  { id: "l-cr", name: "Customer reported" },
                  ...teamLabels,
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          });
    }
    if (q === "linear.WorkflowStates") {
      return json({
        data: { workflowStates: { nodes: [{ id: "s-done", name: "Done" }] } },
      });
    }
    if (q === "linear.Projects") {
      assert.equal(body.variables.teamId, "t-eng");
      return json({
        data: { projects: { nodes: [{ id: "p-support", name: "Support" }] } },
      });
    }
    if (q === "linear.Users") {
      return json({
        data: { users: { nodes: [{ id: "u-ebu", name: "Ebubeker Rexha" }] } },
      });
    }
    if (q === "linear.RouteIssueUpdate") {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (q === "linear.RouteRelation") {
      return json({ data: { issueRelationCreate: { success: true } } });
    }
    if (q === "linear.RouteAttachment") {
      return String(body.variables.url).includes("broken")
        ? json({ errors: [{ message: "Unable to fetch url information" }] })
        : json({ data: { attachmentLinkURL: { success: true } } });
    }
    throw new Error(`Unexpected query: ${q.slice(0, 40)}`);
  };
  const updates = () =>
    calls.filter((c) => c.query === "linear.RouteIssueUpdate");
  return { calls, fetchStub, updates };
};

describe("routeTicket", () => {
  it("unions labels, resolves names, inherits the assignee, and writes one update", async () => {
    const linear = fakeLinear();
    const result = await routeTicket(
      {
        addLabels: ["customer reported"],
        duplicateOf: "ENG-9",
        inheritAssigneeFrom: "ENG-9",
        issue: "ENG-1",
        links: [
          {
            title: "Intercom conversation",
            url: "https://app.intercom.com/c/1",
          },
        ],
        priority: 3,
        project: "Support",
        state: "Done",
      },
      { client: linear.fetchStub }
    );
    const [update] = linear.updates();
    assert.equal(linear.updates().length, 1);
    assert.deepEqual(update?.variables.input, {
      assigneeId: "u-anuj",
      labelIds: ["l-bug", "l-cr"],
      priority: 3,
      projectId: "p-support",
      stateId: "s-done",
    });
    const relation = linear.calls.find(
      (c) => c.query === "linear.RouteRelation"
    );
    assert.deepEqual(relation?.variables.input, {
      issueId: "i-1",
      relatedIssueId: "i-9",
      type: "duplicate",
    });
    const attachment = linear.calls.find(
      (c) => c.query === "linear.RouteAttachment"
    );
    assert.equal(attachment?.variables.url, "https://app.intercom.com/c/1");
    assert.equal(result.projectId, "p-support");
    assert.deepEqual(result.labels, ["Bug", "Customer reported"]);
  });

  it("reports a failed link as a warning on a routed ticket", async () => {
    const linear = fakeLinear();
    const result = await routeTicket(
      {
        addLabels: ["Customer reported"],
        issue: "ENG-1",
        links: [
          { title: "Intercom conversation", url: "https://broken.example/1" },
        ],
      },
      { client: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", UNABLE_TO_FETCH);
  });

  it("fails a links-only call when the one link it was asked to write is not attached", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        {
          issue: "ENG-1",
          links: [{ title: "Broken", url: "https://broken.example/1" }],
        },
        { client: linear.fetchStub }
      ),
      NOTHING_WRITTEN
    );
    assert.equal(linear.updates().length, 0);
  });

  it("stays routed with a warning when a links-only call lands and the read-back fails", async () => {
    const linear = fakeLinear({ readBackFails: true });
    const result = await routeTicket(
      {
        issue: "ENG-1",
        links: [{ title: "Intercom", url: "https://app.intercom.com/c/1" }],
      },
      { client: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", READ_BACK_FAILED);
  });

  it("stays routed with a warning when the read-back after the update fails", async () => {
    const linear = fakeLinear({ readBackFails: true });
    const result = await routeTicket(
      { issue: "ENG-1", priority: 3 },
      { client: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 1);
    assert.equal(result.identifier, "ENG-1");
    assert.equal(result.url, "https://linear.app/acquisity/issue/ENG-1");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", READ_BACK_FAILED);
    assert.match(result.warnings[0] ?? "", BEFORE_ROUTING);
  });

  it("rethrows caller cancellation during the read-back instead of reporting routed", async () => {
    const linear = fakeLinear({ readBackFails: true });
    const controller = new AbortController();
    const fetchStub: ProviderClient = (request, init) => {
      const body = {
        query: request.operation,
        variables: "variables" in request.input ? request.input.variables : {},
      } as Call;
      if (body.query === "linear.RouteIssueUpdate") {
        controller.abort();
      }
      return linear.fetchStub(request, init);
    };
    await assert.rejects(
      routeTicket(
        { issue: "ENG-1", priority: 3 },
        { client: fetchStub, signal: controller.signal }
      ),
      LINEAR_BUSY
    );
    assert.equal(linear.updates().length, 1);
  });

  it("inherits an assigned master and falls back to assignee for an unassigned one", async () => {
    const inherited = fakeLinear();
    await routeTicket(
      {
        assignee: "Ebubeker Rexha",
        inheritAssigneeFrom: "ENG-9",
        issue: "ENG-1",
      },
      { client: inherited.fetchStub }
    );
    assert.deepEqual(inherited.updates()[0]?.variables.input, {
      assigneeId: "u-anuj",
    });

    const fallback = fakeLinear();
    await routeTicket(
      {
        assignee: "Ebubeker Rexha",
        inheritAssigneeFrom: "ENG-1",
        issue: "ENG-1",
      },
      { client: fallback.fetchStub }
    );
    const [update] = fallback.updates();
    assert.deepEqual(update?.variables.input, { assigneeId: "u-ebu" });
  });

  it("fails before any write when the duplicate target does not exist", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        { duplicateOf: "ENG-999999", issue: "ENG-1", state: "Done" },
        { client: linear.fetchStub }
      ),
      NO_ISSUE
    );
    assert.equal(linear.updates().length, 0);
  });

  it("rejects an unknown label before any write and lists the valid names", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        { addLabels: ["Nope"], issue: "ENG-1", state: "Done" },
        { client: linear.fetchStub }
      ),
      UNKNOWN_LABEL
    );
    assert.equal(linear.updates().length, 0);
  });
});

const FEATURE_LABELS = [
  { id: "l-fr", name: "Feature Request" },
  { id: "l-ok", name: "Approved" },
  { id: "l-area", name: "Area: CRM Records" },
];
const NOT_IN_MAP = /"Pieter Venter" is not in the owner map/u;
const OTHER_NOT_IN_MAP = /"Jil Patel" is not in the owner map/u;
const MASTER_OUTSIDE_MAP =
  /ENG-9 is held by Pieter Venter, who is not in the owner map, so nothing was written/u;
const JAMES_IS_A_DEVELOPER = /James Keeble is a developer/u;
const A_DEVELOPER = /Ebubeker Rexha is a developer/u;
const NOT_INHERITED =
  /not in the owner map, so the assignee was not inherited/u;
const EBU_KEEPS_UNAPPROVED =
  /ENG-1 is held by Ebubeker Rexha, a developer, and this label change would leave it labelled Feature Request, so nothing was written/u;
const JAMES_KEEPS_UNAPPROVED =
  /ENG-1 is held by James Keeble, a developer, and this label change would leave it labelled Feature Request, so nothing was written/u;
const EBU_KEEPS_UNLABELLED =
  /ENG-1 is held by Ebubeker Rexha, a developer, and this label change would leave it labelled Customer reported, so nothing was written/u;

describe("routeTicket owner map", () => {
  it("refuses an assignee who is not in the owner map before any write", async () => {
    const cases: [string, RegExp][] = [
      ["Pieter Venter", NOT_IN_MAP],
      ["Jil Patel", OTHER_NOT_IN_MAP],
    ];
    await Promise.all(
      cases.map(async ([assignee, message]) => {
        const linear = fakeLinear();
        await assert.rejects(
          routeTicket(
            { assignee, issue: "ENG-1" },
            { client: linear.fetchStub }
          ),
          message
        );
        assert.equal(linear.updates().length, 0);
      })
    );
  });

  it("assigns a mapped developer to a Bug, by name", async () => {
    const linear = fakeLinear();
    await routeTicket(
      { assignee: "ebubeker rexha", issue: "ENG-1" },
      { client: linear.fetchStub }
    );
    const users = linear.calls.find((c) => c.query === "linear.Users");
    assert.equal(users?.variables.name, "Ebubeker Rexha");
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      assigneeId: "u-ebu",
    });
  });

  it("refuses a developer for a ticket that is neither a Bug nor an approved feature request", async () => {
    const kinds = [
      { labels: [], name: "unlabelled" },
      { labels: [{ id: "l-fr", name: "Feature Request" }], name: "unapproved" },
      { labels: [{ id: "l-ok", name: "Approved" }], name: "approved only" },
    ];
    await Promise.all(
      kinds.map(async (kind) => {
        const linear = fakeLinear({
          teamLabels: FEATURE_LABELS,
          ticketLabels: kind.labels,
        });
        await assert.rejects(
          routeTicket(
            { assignee: "Ebubeker Rexha", issue: "ENG-1" },
            { client: linear.fetchStub }
          ),
          A_DEVELOPER,
          kind.name
        );
        assert.equal(linear.updates().length, 0, kind.name);
      })
    );
  });

  it("counts the labels being added when it checks the gate", async () => {
    const linear = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketLabels: [{ id: "l-fr", name: "Feature Request" }],
    });
    await routeTicket(
      {
        addLabels: ["Approved", "Area: CRM Records"],
        assignee: "Ebubeker Rexha",
        issue: "ENG-1",
      },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      assigneeId: "u-ebu",
      labelIds: ["l-fr", "l-ok", "l-area"],
    });
  });

  it("takes the named labels off while keeping the rest", async () => {
    const linear = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketLabels: [
        { id: "l-bug", name: "Bug" },
        { id: "l-need", name: "Needs approval" },
      ],
    });
    await routeTicket(
      {
        addLabels: ["Approved"],
        issue: "ENG-1",
        removeLabels: ["needs approval"],
      },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      labelIds: ["l-bug", "l-ok"],
    });
    const removeOnly = fakeLinear({
      ticketLabels: [
        { id: "l-bug", name: "Bug" },
        { id: "l-need", name: "Needs approval" },
      ],
    });
    await routeTicket(
      { issue: "ENG-1", removeLabels: ["Needs approval"] },
      { client: removeOnly.fetchStub }
    );
    assert.deepEqual(removeOnly.updates()[0]?.variables.input, {
      labelIds: ["l-bug"],
    });
    assert.equal(
      removeOnly.calls.some((call) => call.query === "linear.TeamLabels"),
      false
    );
  });

  it("ignores a label to remove that the ticket does not carry", async () => {
    const linear = fakeLinear();
    const result = await routeTicket(
      { issue: "ENG-1", removeLabels: ["Needs approval"] },
      { client: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 0);
    assert.equal(result.identifier, "ENG-1");
  });

  it("unassigns a developer when the outcome is not a developer one", async () => {
    const held = { id: "u-anuj", name: "Anuj Bhatt" };
    const released = fakeLinear({ ticketAssignee: held });
    await routeTicket(
      { issue: "ENG-1", priority: 3, releaseDeveloper: true },
      { client: released.fetchStub }
    );
    assert.deepEqual(released.updates()[0]?.variables.input, {
      assigneeId: null,
      priority: 3,
    });
    await Promise.all(
      [
        { id: "u-james", name: "James Keeble" },
        { id: "u-aaron", name: "Aaron Fraga" },
        { id: "u-gone", name: "Pieter Venter" },
      ].map(async (keeper) => {
        const kept = fakeLinear({ ticketAssignee: keeper });
        await routeTicket(
          { issue: "ENG-1", priority: 3, releaseDeveloper: true },
          { client: kept.fetchStub }
        );
        assert.deepEqual(kept.updates()[0]?.variables.input, { priority: 3 });
      })
    );
    const replaced = fakeLinear({ ticketAssignee: held });
    await routeTicket(
      { assignee: "Ebubeker Rexha", issue: "ENG-1", releaseDeveloper: true },
      { client: replaced.fetchStub }
    );
    assert.deepEqual(replaced.updates()[0]?.variables.input, {
      assigneeId: "u-ebu",
    });
  });

  it("applies the developer gate to an inherited owner, warning instead of failing", async () => {
    const cases = [
      { allowed: false, labels: [] as { id: string; name: string }[] },
      { allowed: false, labels: [{ id: "l-fr", name: "Feature Request" }] },
      { allowed: true, labels: [{ id: "l-bug", name: "Bug" }] },
      {
        allowed: true,
        labels: [
          { id: "l-fr", name: "Feature Request" },
          { id: "l-ok", name: "Approved" },
        ],
      },
    ];
    await Promise.all(
      cases.map(async (item) => {
        const linear = fakeLinear({
          teamLabels: FEATURE_LABELS,
          ticketLabels: item.labels,
        });
        const result = await routeTicket(
          {
            duplicateOf: "ENG-9",
            inheritAssigneeFrom: "ENG-9",
            issue: "ENG-1",
            state: "Done",
          },
          { client: linear.fetchStub }
        );
        const input = linear.updates()[0]?.variables.input as Record<
          string,
          unknown
        >;
        assert.equal(input.assigneeId, item.allowed ? "u-anuj" : undefined);
        assert.equal(result.warnings.length > 0, !item.allowed);
      })
    );
  });

  it("lets a support owner be inherited by any ticket", async () => {
    const linear = fakeLinear({
      masterAssignee: { id: "u-aaron", name: "Aaron Fraga" },
      ticketLabels: [],
    });
    await routeTicket(
      { inheritAssigneeFrom: "ENG-9", issue: "ENG-1" },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      assigneeId: "u-aaron",
    });
  });

  it("refuses before any write to parent a report under a master held outside the map", async () => {
    const linear = fakeLinear({
      masterAssignee: { id: "u-gone", name: "Pieter Venter" },
    });
    await assert.rejects(
      routeTicket(
        {
          assignee: "Ebubeker Rexha",
          inheritAssigneeFrom: "ENG-9",
          issue: "ENG-1",
          parent: "ENG-9",
        },
        { client: linear.fetchStub }
      ),
      MASTER_OUTSIDE_MAP
    );
    assert.equal(linear.updates().length, 0);
  });

  it("builds eligibility from the labels the ticket will have, not the ones it is losing", async () => {
    const cases: { name: string; removeLabels: string[] }[] = [
      { name: "Approved", removeLabels: ["Approved"] },
      { name: "Feature Request", removeLabels: ["feature request"] },
    ];
    await Promise.all(
      cases.map(async (item) => {
        const linear = fakeLinear({
          teamLabels: FEATURE_LABELS,
          ticketLabels: [
            { id: "l-fr", name: "Feature Request" },
            { id: "l-ok", name: "Approved" },
          ],
        });
        await assert.rejects(
          routeTicket(
            {
              assignee: "Ebubeker Rexha",
              issue: "ENG-1",
              removeLabels: item.removeLabels,
            },
            { client: linear.fetchStub }
          ),
          A_DEVELOPER,
          item.name
        );
        assert.equal(linear.updates().length, 0, item.name);
      })
    );
    const added = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketLabels: [{ id: "l-fr", name: "Feature Request" }],
    });
    await routeTicket(
      {
        addLabels: ["Approved"],
        assignee: "Ebubeker Rexha",
        issue: "ENG-1",
        removeLabels: ["Needs approval"],
      },
      { client: added.fetchStub }
    );
    assert.equal(added.updates().length, 1);
  });

  it("applies removals before additions, so a label removed and added again still counts", async () => {
    const linear = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-ok", name: "Approved" },
      ],
    });
    await routeTicket(
      {
        addLabels: ["Approved"],
        assignee: "Ebubeker Rexha",
        issue: "ENG-1",
        removeLabels: ["Approved"],
      },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      assigneeId: "u-ebu",
      labelIds: ["l-fr", "l-ok"],
    });
  });

  it("lets James, and only James, hold a feature request that is waiting for approval", async () => {
    const waiting = [
      { id: "l-fr", name: "Feature Request" },
      { id: "l-need", name: "Needs approval" },
    ];
    const james = fakeLinear({ ticketLabels: waiting });
    await routeTicket(
      { assignee: "James Keeble", issue: "ENG-1" },
      { client: james.fetchStub }
    );
    assert.equal(james.updates().length, 1);
    const other = fakeLinear({ ticketLabels: waiting });
    await assert.rejects(
      routeTicket(
        { assignee: "Ebubeker Rexha", issue: "ENG-1" },
        { client: other.fetchStub }
      ),
      A_DEVELOPER
    );
    const bare = fakeLinear({
      ticketLabels: [{ id: "l-fr", name: "Feature Request" }],
    });
    await assert.rejects(
      routeTicket(
        { assignee: "James Keeble", issue: "ENG-1" },
        { client: bare.fetchStub }
      ),
      JAMES_IS_A_DEVELOPER
    );
  });

  it("refuses a label change that leaves the developer already holding the ticket ineligible", async () => {
    const ebu = { id: "u-ebu", name: "Ebubeker Rexha" };
    const approved = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketAssignee: ebu,
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-ok", name: "Approved" },
      ],
    });
    await assert.rejects(
      routeTicket(
        { issue: "ENG-1", removeLabels: ["Approved"] },
        { client: approved.fetchStub }
      ),
      EBU_KEEPS_UNAPPROVED
    );
    assert.equal(approved.updates().length, 0);
    const bug = fakeLinear({
      ticketAssignee: ebu,
      ticketLabels: [
        { id: "l-bug", name: "Bug" },
        { id: "l-cr", name: "Customer reported" },
      ],
    });
    await assert.rejects(
      routeTicket(
        { issue: "ENG-1", priority: 2, removeLabels: ["Bug"] },
        { client: bug.fetchStub }
      ),
      EBU_KEEPS_UNLABELLED
    );
    assert.equal(bug.updates().length, 0);
    const released = fakeLinear({
      teamLabels: FEATURE_LABELS,
      ticketAssignee: ebu,
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-ok", name: "Approved" },
      ],
    });
    await routeTicket(
      { issue: "ENG-1", releaseDeveloper: true, removeLabels: ["Approved"] },
      { client: released.fetchStub }
    );
    assert.deepEqual(released.updates()[0]?.variables.input, {
      assigneeId: null,
      labelIds: ["l-fr"],
    });
  });

  it("keeps James on a feature request moved back to waiting for approval", async () => {
    const linear = fakeLinear({
      teamLabels: [...FEATURE_LABELS, { id: "l-need", name: "Needs approval" }],
      ticketAssignee: { id: "u-james", name: "James Keeble" },
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-ok", name: "Approved" },
      ],
    });
    await routeTicket(
      {
        addLabels: ["Needs approval"],
        issue: "ENG-1",
        releaseDeveloper: true,
        removeLabels: ["Approved"],
      },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      labelIds: ["l-fr", "l-need"],
    });
    const dropped = fakeLinear({
      ticketAssignee: { id: "u-james", name: "James Keeble" },
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-need", name: "Needs approval" },
      ],
    });
    await assert.rejects(
      routeTicket(
        {
          issue: "ENG-1",
          releaseDeveloper: true,
          removeLabels: ["Needs approval"],
        },
        { client: dropped.fetchStub }
      ),
      JAMES_KEEPS_UNAPPROVED
    );
    assert.equal(dropped.updates().length, 0);
  });

  it("lets a support owner take any ticket", async () => {
    const linear = fakeLinear({ ticketLabels: [] });
    await routeTicket(
      { assignee: "Aaron Fraga", issue: "ENG-1" },
      { client: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 1);
  });

  it("does not inherit an assignee outside the map and uses the fallback", async () => {
    const linear = fakeLinear({
      masterAssignee: { id: "u-gone", name: "Pieter Venter" },
    });
    const result = await routeTicket(
      {
        assignee: "Ebubeker Rexha",
        inheritAssigneeFrom: "ENG-9",
        issue: "ENG-1",
      },
      { client: linear.fetchStub }
    );
    assert.deepEqual(linear.updates()[0]?.variables.input, {
      assigneeId: "u-ebu",
    });
    assert.match(result.warnings[0] ?? "", NOT_INHERITED);
  });
});

describe("route_ticket tool", () => {
  it("never requires an approval card, and denies questions-only sessions", async () => {
    const { approval } = tool;
    const approve = approval as (ctx: unknown) => unknown;
    const auth = (attributes: Record<string, string>) => ({
      attributes,
      authenticator: "slack",
      principalId: "user:1",
      principalType: "user",
    });
    const ordinary = auth({});
    assert.equal(
      await approve({
        session: { auth: { current: ordinary, initiator: ordinary } },
      }),
      "not-applicable"
    );
    const questions = auth({ questionsOnly: "true" });
    assert.equal(
      (
        (await approve({
          session: { auth: { current: questions, initiator: questions } },
        })) as { type: string }
      ).type,
      "denied"
    );
  });
});
