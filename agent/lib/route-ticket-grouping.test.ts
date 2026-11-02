import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTicket } from "./route-ticket.js";
import { type FakeIssue, fakeLinear } from "./route-ticket-fixtures.js";

const ANUJ = { id: "u-anuj", name: "Anuj Bhatt" };
const FRESH = "2026-10-20T00:00:00.000Z";

/**
 * ENG-30 is an open master with report ENG-20 under it, ENG-40 a lone report
 * (ENG-15932's shape: closed, nothing under it), and ENG-80 a master that is
 * already Done.
 */
const ISSUES: Record<string, FakeIssue> = {
  "ENG-20": { labels: ["Customer reported"], parent: "ENG-30" },
  "ENG-30": { assignee: ANUJ, createdAt: FRESH, master: true },
  "ENG-40": { createdAt: FRESH, stateType: "completed" },
  "ENG-80": {
    assignee: ANUJ,
    createdAt: FRESH,
    master: true,
    stateType: "completed",
  },
  "ENG-81": {
    assignee: ANUJ,
    createdAt: FRESH,
    master: true,
    parent: "ENG-30",
    stateType: "completed",
  },
  "ENG-82": { labels: ["Customer reported"], parent: "ENG-81" },
};

const GROUPING = { id: "l-grouping", name: "Needs grouping" };

/** ENG-1 as each classification leaves it: the labels the decision put on it. */
const CLASSIFIED: Record<string, { id: string; name: string }[]> = {
  Bug: [{ id: "l-bug", name: "Bug" }],
  "Feature Request": [
    { id: "l-fr", name: "Feature Request" },
    { id: "l-na", name: "Needs approval" },
  ],
  "Platform Limitation": [{ id: "l-cr", name: "Customer reported" }],
  "User Error": [{ id: "l-cr", name: "Customer reported" }],
};

const linear = (over: Parameters<typeof fakeLinear>[0] = {}) =>
  fakeLinear({ issues: ISSUES, teamLabels: [GROUPING], ...over });

const updateOf = (fake: ReturnType<typeof fakeLinear>) =>
  fake.updates()[0]?.variables.input as Record<string, unknown> | undefined;

const labelIdsOf = (fake: ReturnType<typeof fakeLinear>) =>
  (updateOf(fake)?.labelIds ?? []) as string[];

const SELF_DECLINE = /Only a person adds Declined/u;
const UNAPPROVED_CLOSE =
  /an unapproved Feature Request never closes unless a person declined it/u;
const RELATED_LANDED =
  /related link to ENG-40 was recorded.*Call route_ticket again with the same input, duplicateOf ENG-40 included/su;
const WITHOUT_DUPLICATE = /without duplicateOf/u;
const RELATED_RETRY =
  /Call route_ticket again with the same input, relatedTo ENG-40 included/u;
const DUPLICATE_FIELD = /duplicateOf/u;
const SELF_APPROVE = /already carry Approved/u;
const RELATED_CLOSE = /relatedTo keeps the report open/u;
const STALE_PARENT = /was created before 2026-10-25T00:00:00.000Z/u;
const NOT_CONFIRMED = /could not be confirmed under ENG-30/u;
const DUPLICATE_NEEDS_MASTER = /Duplicate only under an open master/u;

describe("route_ticket never closes a bare duplicate (ENG-17138)", () => {
  for (const [classification, ticketLabels] of Object.entries(
    CLASSIFIED
  ).filter(([name]) => name !== "Feature Request")) {
    it(`leaves a ${classification} duplicate of a lone closed report open, related and labelled Needs grouping`, async () => {
      const fake = linear({ ticketLabels });
      const result = await routeTicket(
        {
          addLabels: ["Customer reported"],
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          priority: 4,
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      );
      assert.deepEqual(fake.relations, ["i-1>i-ENG-40"]);
      assert.deepEqual(fake.relationTypes, ["related"]);
      const update = updateOf(fake);
      assert.equal(update?.stateId, "s-backlog");
      assert.equal(update?.parentId, undefined);
      assert.ok(labelIdsOf(fake).includes("l-grouping"));
      assert.equal(result.duplicateOf, null);
      assert.equal(result.grouping, "needs-grouping");
      assert.ok(result.warnings.some((w) => w.includes("Needs grouping")));
    });
  }

  it("treats a master that is already closed as no master", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const result = await routeTicket(
      { duplicateOf: "ENG-80", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relationTypes, ["related"]);
    assert.equal(updateOf(fake)?.stateId, "s-backlog");
    assert.equal(result.grouping, "needs-grouping");
  });

  it("closes a duplicate under an open master and reads the parent back before success", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const result = await routeTicket(
      { duplicateOf: "ENG-20", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relationTypes, ["duplicate"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.stateId, "s-duplicate");
    assert.equal(result.parentIdentifier, "ENG-30");
    assert.equal(result.grouping, "joined");
  });

  it("fails a Duplicate whose read-back does not show the master as parent", async () => {
    const fake = linear({ dropParent: true, ticketLabels: CLASSIFIED.Bug });
    await assert.rejects(
      routeTicket(
        { duplicateOf: "ENG-20", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      ),
      NOT_CONFIRMED
    );
  });

  it("refuses the Duplicate state with no match unless the parent is an open master", async () => {
    for (const parent of [undefined, "ENG-40", "ENG-80"]) {
      const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await assert.rejects(
        routeTicket(
          { issue: "ENG-1", ...(parent ? { parent } : {}), state: "Duplicate" },
          { client: fake.fetchStub }
        ),
        DUPLICATE_NEEDS_MASTER,
        String(parent)
      );
      assert.deepEqual(fake.writes(), [], String(parent));
    }
  });
});

describe("route_ticket keeps a related report open", () => {
  it("parents a feature request related to a report under that report's open master, still in Backlog", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["Feature Request"] });
    const result = await routeTicket(
      { issue: "ENG-1", relatedTo: "ENG-20", state: "Backlog" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relationTypes, ["related"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.stateId, "s-backlog");
    assert.equal(result.grouping, "joined");
  });

  it("labels a feature request related to a lone report Needs grouping, still in Backlog", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["Feature Request"] });
    const result = await routeTicket(
      { issue: "ENG-1", relatedTo: "ENG-40", state: "Backlog" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relationTypes, ["related"]);
    assert.equal(updateOf(fake)?.stateId, "s-backlog");
    assert.ok(labelIdsOf(fake).includes("l-grouping"));
    assert.equal(result.grouping, "needs-grouping");
  });
});

describe("route_ticket never closes an unapproved feature request (ENG-15932)", () => {
  it("refuses Canceled, Done or Duplicate for a Feature Request with no Approved or Declined, before any write", async () => {
    for (const state of ["Canceled", "Done", "Duplicate"]) {
      const fake = linear({ ticketLabels: CLASSIFIED["Feature Request"] });
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await assert.rejects(
        routeTicket(
          {
            issue: "ENG-1",
            state,
            ...(state === "Duplicate" ? { duplicateOf: "ENG-20" } : {}),
          },
          { client: fake.fetchStub }
        ),
        UNAPPROVED_CLOSE,
        state
      );
      assert.deepEqual(fake.writes(), [], state);
    }
  });

  it("refuses the closure when this call adds the Feature Request label", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    await assert.rejects(
      routeTicket(
        {
          addLabels: ["Feature Request"],
          issue: "ENG-1",
          state: "Canceled",
        },
        { client: fake.fetchStub }
      ),
      UNAPPROVED_CLOSE
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("lets a feature request a person already declined close", async () => {
    const fake = linear({
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-declined", name: "Declined" },
      ],
    });
    await routeTicket(
      { issue: "ENG-1", state: "Canceled" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.stateId, "s-canceled");
  });

  it("refuses a route that adds Declined itself, before any write, so Foreman never declines for a person", async () => {
    for (const state of ["Canceled", "Backlog"]) {
      const fake = linear({
        teamLabels: [GROUPING, { id: "l-declined", name: "Declined" }],
        ticketLabels: CLASSIFIED["Feature Request"],
      });
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await assert.rejects(
        routeTicket(
          { addLabels: ["Declined"], issue: "ENG-1", state },
          { client: fake.fetchStub }
        ),
        SELF_DECLINE,
        state
      );
      assert.deepEqual(fake.writes(), [], state);
    }
  });
});

describe("a report left for grouping leaves Triage (C6)", () => {
  it("moves a non-feature repeat with no open master to Backlog with Aaron, not the match's owner", async () => {
    for (const ticketLabels of [CLASSIFIED.Bug, CLASSIFIED["User Error"]]) {
      const fake = linear({ ticketLabels });
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await routeTicket(
        {
          duplicateOf: "ENG-40",
          inheritAssigneeFrom: "ENG-40",
          issue: "ENG-1",
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      );
      assert.equal(updateOf(fake)?.stateId, "s-backlog");
      assert.equal(updateOf(fake)?.assigneeId, "u-aaron");
    }
  });

  it("moves an approved feature request with no open master to Backlog with James", async () => {
    const fake = linear({
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-ok", name: "Approved" },
      ],
    });
    await routeTicket(
      { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.stateId, "s-backlog");
    assert.equal(updateOf(fake)?.assigneeId, "u-james");
  });
});

describe("a failed update after the relation keeps the retry able to close (C5)", () => {
  it("tells a repeat that only got a related link to retry with duplicateOf", async () => {
    const fake = linear({
      ticketLabels: CLASSIFIED["User Error"],
      updateFailures: 1,
    });
    const message = await routeTicket(
      {
        duplicateOf: "ENG-40",
        issue: "ENG-1",
        releaseDeveloper: true,
        state: "Duplicate",
      },
      { client: fake.fetchStub }
    ).then(
      () => "",
      (error: Error) => error.message
    );
    assert.match(message, RELATED_LANDED);
    assert.doesNotMatch(message, WITHOUT_DUPLICATE);
  });
});

describe("a declined request stays closed when it cannot join a master (R1)", () => {
  it("keeps a Declined feature request Canceled, related to its lone match and labelled Needs grouping", async () => {
    const fake = linear({
      ticketLabels: [
        { id: "l-fr", name: "Feature Request" },
        { id: "l-declined", name: "Declined" },
      ],
    });
    const result = await routeTicket(
      { issue: "ENG-1", relatedTo: "ENG-40", state: "Canceled" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relationTypes, ["related"]);
    assert.equal(updateOf(fake)?.stateId, "s-canceled");
    assert.equal(updateOf(fake)?.assigneeId, undefined);
    assert.ok(labelIdsOf(fake).includes("l-grouping"));
    assert.equal(result.grouping, "needs-grouping");
  });
});

describe("a feature request's partial write keeps its match field (C1)", () => {
  it("tells a feature request whose update failed after the related link to retry with relatedTo, not duplicateOf", async () => {
    const fake = linear({
      ticketLabels: CLASSIFIED["Feature Request"],
      updateFailures: 1,
    });
    const message = await routeTicket(
      {
        assignee: "James Keeble",
        issue: "ENG-1",
        relatedTo: "ENG-40",
        state: "Backlog",
      },
      { client: fake.fetchStub }
    ).then(
      () => "",
      (error: Error) => error.message
    );
    assert.match(message, RELATED_RETRY);
    assert.doesNotMatch(message, DUPLICATE_FIELD);
    const retried = await routeTicket(
      {
        assignee: "James Keeble",
        issue: "ENG-1",
        relatedTo: "ENG-40",
        state: "Backlog",
      },
      { client: fake.fetchStub }
    );
    assert.equal(retried.grouping, "needs-grouping");
  });
});

describe("a closed master hands its reports to its open parent master (C2)", () => {
  it("parents a duplicate of a closed master under that master's open parent and closes it there", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const result = await routeTicket(
      { duplicateOf: "ENG-81", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.stateId, "s-duplicate");
    assert.equal(result.grouping, "joined");
  });
});

describe("Cubic review of #259", () => {
  it("refuses to close a Feature Request whose Approved label is only being added in this call, before any write (P1)", async () => {
    const fake = linear({
      teamLabels: [GROUPING, { id: "l-ok", name: "Approved" }],
      ticketLabels: CLASSIFIED["Feature Request"],
    });
    await assert.rejects(
      routeTicket(
        { addLabels: ["Approved"], issue: "ENG-1", state: "Done" },
        { client: fake.fetchStub }
      ),
      SELF_APPROVE
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("refuses relatedTo with a closing state unless a person already decided the request, before any write (P1)", async () => {
    for (const state of ["Done", "Canceled"]) {
      const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await assert.rejects(
        routeTicket(
          { issue: "ENG-1", relatedTo: "ENG-40", state },
          { client: fake.fetchStub }
        ),
        RELATED_CLOSE,
        state
      );
      assert.deepEqual(fake.writes(), [], state);
    }
  });

  it("joins the open master above a closed master the matched report sits under", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const result = await routeTicket(
      { duplicateOf: "ENG-82", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(result.grouping, "joined");
  });

  it("applies the session cutoff to a parent-only Duplicate retry, before any write", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    await assert.rejects(
      routeTicket(
        { issue: "ENG-1", parent: "ENG-30", state: "Duplicate" },
        {
          client: fake.fetchStub,
          mastersCreatedAfter: "2026-10-25T00:00:00.000Z",
        }
      ),
      STALE_PARENT
    );
    assert.deepEqual(fake.writes(), []);
  });
});
