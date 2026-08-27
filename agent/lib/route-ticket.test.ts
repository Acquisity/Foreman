import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTicket } from "./linear-api.js";
import { AUTONOMOUS_PRINCIPAL } from "./trust.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: tool } = await import("../tools/route_ticket.js");

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
const fakeLinear = () => {
  const calls: Call[] = [];
  const fetchStub: typeof fetch = (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    if (q.startsWith("query RouteIssue")) {
      const master = body.variables.id === "ENG-9";
      return json({
        data: {
          issue: {
            assignee: master ? { id: "u-ada", name: "Ada" } : null,
            id: master ? "i-9" : "i-1",
            identifier: body.variables.id,
            labels: { nodes: master ? [] : [{ id: "l-bug", name: "Bug" }] },
            team: { id: "t-eng" },
          },
        },
      });
    }
    if (q.startsWith("query TeamLabels")) {
      return json({
        data: {
          issueLabels: {
            nodes: [
              { id: "l-bug", name: "Bug" },
              { id: "l-cr", name: "Customer reported" },
            ],
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
      return json({ data: { attachmentLinkURL: { success: true } } });
    }
    return json({
      data: {
        issue: {
          assignee: { name: "Ada" },
          identifier: "ENG-1",
          labels: { nodes: [{ name: "Bug" }, { name: "Customer reported" }] },
          parent: null,
          priority: 3,
          project: { id: "p-support", name: "Support" },
          state: { name: "Done" },
          url: "https://linear.app/acquisity/issue/ENG-1",
        },
      },
    });
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

  it("lets an explicit assignee beat an inherited one", async () => {
    const linear = fakeLinear();
    await routeTicket(
      "t",
      { assignee: "Grace", inheritAssigneeFrom: "ENG-9", issue: "ENG-1" },
      { fetch: linear.fetchStub }
    );
    const [update] = linear.updates();
    assert.deepEqual(update?.variables.input, { assigneeId: "u-grace" });
    assert.equal(
      linear.calls.some(
        (c) =>
          c.query.startsWith("query RouteIssue") && c.variables.id === "ENG-9"
      ),
      false
    );
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
