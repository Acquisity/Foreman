import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTicket } from "./linear-api.js";
import { AUTONOMOUS_PRINCIPAL } from "./trust.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: tool } = await import("../tools/route_ticket.js");

const UNABLE_TO_FETCH = /Unable to fetch url information/u;
const NO_ISSUE = /No issue ENG-999999/u;
const UNKNOWN_LABEL =
  /Unknown label "Nope"\. Valid labels: Bug, Customer reported/u;

const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  );

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/** A Linear stand-in: ENG-1 (Bug label, unassigned) and master ENG-9 (assigned to Ada). */
const READ_BACK_FAILED = /could not be read back/u;
const BEFORE_ROUTING = /before routing/u;
const LINEAR_BUSY = /Linear is busy/u;
const NOTHING_WRITTEN = /Nothing was written/u;

const labelsFor = (master: boolean, readBack: boolean) => {
  if (master) {
    return [];
  }
  return readBack
    ? [
        { id: "l-bug", name: "Bug" },
        { id: "l-cr", name: "Customer reported" },
      ]
    : [{ id: "l-bug", name: "Bug" }];
};

const fakeLinear = ({ readBackFails = false } = {}) => {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    if (q.startsWith("query RouteIssue")) {
      if (body.variables.id === "ENG-999999") {
        return json({ data: { issue: null } });
      }
      const master = body.variables.id === "ENG-9";
      // A read of ENG-1 after the update is the read-back.
      const readBack =
        !master &&
        calls.some((c) => c.query.startsWith("mutation RouteIssueUpdate"));
      if (readBack && readBackFails) {
        return json({ errors: [{ message: "Linear is busy" }] });
      }
      return json({
        data: {
          issue: {
            assignee: master || readBack ? { id: "u-ada", name: "Ada" } : null,
            id: master ? "i-9" : "i-1",
            identifier: body.variables.id,
            labels: { nodes: labelsFor(master, readBack) },
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
    if (q.startsWith("query TeamLabels")) {
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
                nodes: [{ id: "l-cr", name: "Customer reported" }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          });
    }
    if (q.startsWith("query WorkflowStates")) {
      return json({
        data: { workflowStates: { nodes: [{ id: "s-done", name: "Done" }] } },
      });
    }
    if (q.startsWith("query Projects")) {
      assert.equal(body.variables.teamId, "t-eng");
      return json({
        data: { projects: { nodes: [{ id: "p-support", name: "Support" }] } },
      });
    }
    if (q.startsWith("query Users")) {
      return json({
        data: { users: { nodes: [{ id: "u-grace", name: "Grace" }] } },
      });
    }
    if (q.startsWith("mutation RouteIssueUpdate")) {
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (q.startsWith("mutation RouteRelation")) {
      return json({ data: { issueRelationCreate: { success: true } } });
    }
    if (q.startsWith("mutation RouteAttachment")) {
      return String(body.variables.url).includes("broken")
        ? json({ errors: [{ message: "Unable to fetch url information" }] })
        : json({ data: { attachmentLinkURL: { success: true } } });
    }
    throw new Error(`Unexpected query: ${q.slice(0, 40)}`);
  };
  const updates = () =>
    calls.filter((c) => c.query.startsWith("mutation RouteIssueUpdate"));
  return { calls, fetchStub, updates };
};

describe("routeTicket", () => {
  it("unions labels, resolves names, inherits the assignee, and writes one update", async () => {
    const linear = fakeLinear();
    const result = await routeTicket(
      "t",
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
      { fetch: linear.fetchStub }
    );
    const [update] = linear.updates();
    assert.equal(linear.updates().length, 1);
    assert.deepEqual(update?.variables.input, {
      assigneeId: "u-ada",
      labelIds: ["l-bug", "l-cr"],
      priority: 3,
      projectId: "p-support",
      stateId: "s-done",
    });
    const relation = linear.calls.find((c) =>
      c.query.startsWith("mutation RouteRelation")
    );
    assert.deepEqual(relation?.variables.input, {
      issueId: "i-1",
      relatedIssueId: "i-9",
      type: "duplicate",
    });
    const attachment = linear.calls.find((c) =>
      c.query.startsWith("mutation RouteAttachment")
    );
    assert.equal(attachment?.variables.url, "https://app.intercom.com/c/1");
    assert.equal(result.projectId, "p-support");
    assert.deepEqual(result.labels, ["Bug", "Customer reported"]);
  });

  it("reports a failed link as a warning on a routed ticket", async () => {
    const linear = fakeLinear();
    const result = await routeTicket(
      "t",
      {
        addLabels: ["Customer reported"],
        issue: "ENG-1",
        links: [
          { title: "Intercom conversation", url: "https://broken.example/1" },
        ],
      },
      { fetch: linear.fetchStub }
    );
    assert.equal(linear.updates().length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", UNABLE_TO_FETCH);
  });

  it("fails a links-only call when the one link it was asked to write is not attached", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        "t",
        {
          issue: "ENG-1",
          links: [{ title: "Broken", url: "https://broken.example/1" }],
        },
        { fetch: linear.fetchStub }
      ),
      NOTHING_WRITTEN
    );
    assert.equal(linear.updates().length, 0);
  });

  it("stays routed with a warning when the read-back after the update fails", async () => {
    const linear = fakeLinear({ readBackFails: true });
    const result = await routeTicket(
      "t",
      { issue: "ENG-1", priority: 3 },
      { fetch: linear.fetchStub }
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
    const fetchStub: typeof fetch = (url, init) => {
      const body = JSON.parse(String(init?.body)) as Call;
      if (body.query.startsWith("mutation RouteIssueUpdate")) {
        controller.abort();
      }
      return linear.fetchStub(url, init);
    };
    await assert.rejects(
      routeTicket(
        "t",
        { issue: "ENG-1", priority: 3 },
        { fetch: fetchStub, signal: controller.signal }
      ),
      LINEAR_BUSY
    );
    assert.equal(linear.updates().length, 1);
  });

  it("inherits an assigned master and falls back to assignee for an unassigned one", async () => {
    const inherited = fakeLinear();
    await routeTicket(
      "t",
      { assignee: "Grace", inheritAssigneeFrom: "ENG-9", issue: "ENG-1" },
      { fetch: inherited.fetchStub }
    );
    assert.deepEqual(inherited.updates()[0]?.variables.input, {
      assigneeId: "u-ada",
    });

    const fallback = fakeLinear();
    await routeTicket(
      "t",
      { assignee: "Grace", inheritAssigneeFrom: "ENG-1", issue: "ENG-1" },
      { fetch: fallback.fetchStub }
    );
    const [update] = fallback.updates();
    assert.deepEqual(update?.variables.input, { assigneeId: "u-grace" });
  });

  it("fails before any write when the duplicate target does not exist", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        "t",
        { duplicateOf: "ENG-999999", issue: "ENG-1", state: "Done" },
        { fetch: linear.fetchStub }
      ),
      NO_ISSUE
    );
    assert.equal(linear.updates().length, 0);
  });

  it("rejects an unknown label before any write and lists the valid names", async () => {
    const linear = fakeLinear();
    await assert.rejects(
      routeTicket(
        "t",
        { addLabels: ["Nope"], issue: "ENG-1", state: "Done" },
        { fetch: linear.fetchStub }
      ),
      UNKNOWN_LABEL
    );
    assert.equal(linear.updates().length, 0);
  });
});

describe("route_ticket tool", () => {
  it("denies an autonomous run with a plain reason", async () => {
    const { approval } = tool;
    const status = await (approval as (ctx: unknown) => unknown)({
      session: {
        auth: {
          current: {
            attributes: {},
            authenticator: "github",
            principalId: AUTONOMOUS_PRINCIPAL,
            principalType: "service",
          },
        },
      },
      toolName: "route_ticket",
    });
    assert.deepEqual(status, {
      reason: "Unattended runs do not write to Linear.",
      type: "denied",
    });
  });
});
