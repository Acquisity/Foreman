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

const UNAPPROVED_CLOSE =
  /an unapproved Feature Request never closes unless a person declined it/u;
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
      assert.equal(update?.stateId, undefined);
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
    assert.equal(updateOf(fake)?.stateId, undefined);
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

describe("route_ticket holds a closure until the requester is told", () => {
  it("parents the report under its master but leaves it open when the closure is held", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["Platform Limitation"] });
    const result = await routeTicket(
      {
        addLabels: ["Needs grouping"],
        duplicateOf: "ENG-20",
        issue: "ENG-1",
        state: "Duplicate",
      },
      { client: fake.fetchStub, holdClosure: true }
    );
    assert.deepEqual(fake.relationTypes, ["related"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.stateId, undefined);
    assert.equal(result.closureHeld, true);
  });

  it("closes the held duplicate under its master with Needs grouping once the reply has gone out", async () => {
    const route = {
      addLabels: ["Needs grouping"],
      duplicateOf: "ENG-20",
      issue: "ENG-1",
      releaseDeveloper: true,
      state: "Duplicate",
    };
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const held = await routeTicket(route, {
      client: fake.fetchStub,
      holdClosure: true,
    });
    assert.equal(held.closureHeld, true);
    const told = await routeTicket(route, {
      client: fake.fetchStub,
      holdClosure: false,
    });
    assert.equal(told.closureHeld, false);
    assert.deepEqual(fake.relationTypes, ["related", "duplicate"]);
    const closing = fake.updates().at(-1)?.variables.input as Record<
      string,
      unknown
    >;
    assert.equal(closing.stateId, "s-duplicate");
    assert.equal(closing.parentId, "i-ENG-30");
    assert.ok((closing.labelIds as string[]).includes("l-grouping"));
    assert.equal(told.duplicateOf, "ENG-20");
  });

  it("closes a held Canceled route once the reply has gone out", async () => {
    const route = {
      addLabels: ["Needs grouping"],
      issue: "ENG-1",
      releaseDeveloper: true,
      state: "Canceled",
    };
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    await routeTicket(route, { client: fake.fetchStub, holdClosure: true });
    await routeTicket(route, { client: fake.fetchStub });
    const closing = fake.updates().at(-1)?.variables.input as Record<
      string,
      unknown
    >;
    assert.equal(closing.stateId, "s-canceled");
    assert.ok((closing.labelIds as string[]).includes("l-grouping"));
  });

  it("leaves a held Canceled route open with its other fields applied", async () => {
    const fake = linear({ ticketLabels: CLASSIFIED["User Error"] });
    const result = await routeTicket(
      {
        addLabels: ["Needs grouping"],
        issue: "ENG-1",
        priority: 4,
        state: "Canceled",
      },
      { client: fake.fetchStub, holdClosure: true }
    );
    assert.equal(updateOf(fake)?.stateId, undefined);
    assert.equal(updateOf(fake)?.priority, 4);
    assert.equal(result.closureHeld, true);
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
  });

  it("lets a declined feature request close", async () => {
    const fake = linear({
      teamLabels: [GROUPING, { id: "l-declined", name: "Declined" }],
      ticketLabels: CLASSIFIED["Feature Request"],
    });
    await routeTicket(
      { addLabels: ["Declined"], issue: "ENG-1", state: "Canceled" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.stateId, "s-canceled");
  });
});
