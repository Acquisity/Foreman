import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTicket } from "./linear-api.js";
import { type FakeIssue, fakeLinear } from "./route-ticket-fixtures.js";

const ANUJ = { id: "u-anuj", name: "Anuj Bhatt" };
const GONE = { id: "u-gone", name: "Pieter Venter" };
const FRESH = "2026-10-20T00:00:00.000Z";
const STALE = "2026-08-01T00:00:00.000Z";
const CUTOFF = "2026-09-28T00:00:00.000Z";

/**
 * ENG-30 and ENG-31 are masters, ENG-20 a report under ENG-30, ENG-40 a lone
 * report, ENG-50 a master created before the cutoff with report ENG-60 under
 * it, and ENG-70 a master held outside the owner map with report ENG-21.
 */
const ISSUES: Record<string, FakeIssue> = {
  "ENG-20": { labels: ["Customer reported"], parent: "ENG-30" },
  "ENG-21": { labels: ["Customer reported"], parent: "ENG-70" },
  "ENG-30": { assignee: ANUJ, createdAt: FRESH },
  "ENG-31": { assignee: ANUJ, createdAt: FRESH },
  "ENG-40": { labels: ["intercom-sourced", "Customer reported"] },
  "ENG-50": { assignee: ANUJ, createdAt: STALE },
  "ENG-60": { labels: ["Customer reported"], parent: "ENG-50" },
  "ENG-70": { assignee: GONE, createdAt: FRESH },
  "ENG-77": { createdAt: FRESH },
};

/** ENG-1 without the Bug label: an explanation's duplicate. */
const NOT_A_BUG = [{ id: "l-cr", name: "Customer reported" }];

const linear = (over: Parameters<typeof fakeLinear>[0] = {}) =>
  fakeLinear({ issues: ISSUES, ...over });

const updateOf = (fake: ReturnType<typeof fakeLinear>) =>
  fake.updates()[0]?.variables.input as Record<string, unknown> | undefined;

const NO_MASTER =
  /ENG-40 is a customer report with no master, so nothing was written/u;
const WRONG_PARENT =
  /ENG-20 belongs under its master ENG-30, not ENG-77, so nothing was written/u;
const RELATION_NOT_RECORDED =
  /Nothing was written: the duplicate relation to ENG-9 was not recorded/u;
const MASTER_OUTSIDE_MAP =
  /ENG-70 is held by Pieter Venter, who is not in the owner map, so nothing was written/u;
const STALE_MASTER =
  /ENG-50 was created before 2026-09-28T00:00:00.000Z, so it cannot take new reports and nothing was written/u;

describe("routeTicket duplicates", () => {
  it("records the duplicate relation before moving the ticket to Duplicate, as Linear requires (ENG-15734, ENG-15935, ENG-15785)", async () => {
    const fake = linear();
    const result = await routeTicket(
      { duplicateOf: "ENG-9", issue: "ENG-1", priority: 2, state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.writes(), [
      "linear.RouteRelation",
      "linear.RouteIssueUpdate",
    ]);
    assert.equal(updateOf(fake)?.stateId, "s-duplicate");
    assert.equal(result.duplicateOf, "ENG-9");
    assert.deepEqual(result.warnings, []);
  });

  it("parents a duplicate of a master under that master", async () => {
    const fake = linear();
    await routeTicket(
      { duplicateOf: "ENG-30", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relations, ["i-1>i-ENG-30"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.stateId, "s-duplicate");
  });

  it("parents a duplicate of a report under that report's master, keeping the relation to the report", async () => {
    const fake = linear();
    const result = await routeTicket(
      { duplicateOf: "ENG-20", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relations, ["i-1>i-ENG-20"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(result.duplicateOf, "ENG-20");
  });

  it("refuses a Bug duplicate of a lone report before any write, so the master is made first", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub, masterRequired: true }
      ),
      NO_MASTER
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("closes a duplicate of a lone report without a parent when it is not a Bug", async () => {
    const fake = linear({ ticketLabels: NOT_A_BUG });
    await routeTicket(
      { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.deepEqual(fake.relations, ["i-1>i-ENG-40"]);
    assert.equal(updateOf(fake)?.parentId, undefined);
  });

  it("refuses a parent that is not the match's master before any write", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-20",
          issue: "ENG-1",
          parent: "ENG-77",
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      ),
      WRONG_PARENT
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("writes nothing when the duplicate relation fails, instead of a Duplicate with no relation", async () => {
    const fake = linear({ relationFails: true });
    await assert.rejects(
      routeTicket(
        { duplicateOf: "ENG-9", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      ),
      RELATION_NOT_RECORDED
    );
    assert.equal(fake.updates().length, 0);
  });
});

describe("routeTicket duplicate masters, review fixes", () => {
  it("needs a master for a ticket labelled Bug even when no decision says Bug, as after a fallback decision (C1)", async () => {
    const labelled = linear();
    await assert.rejects(
      routeTicket(
        { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
        { client: labelled.fetchStub }
      ),
      NO_MASTER
    );
    const adding = linear({ ticketLabels: NOT_A_BUG });
    await assert.rejects(
      routeTicket(
        {
          addLabels: ["Bug"],
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          state: "Duplicate",
        },
        { client: adding.fetchStub }
      ),
      NO_MASTER
    );
    assert.deepEqual([...labelled.writes(), ...adding.writes()], []);
  });

  it("refuses a computed master held outside the owner map before any write, whoever is assigned (C3)", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        {
          assignee: "Ebubeker Rexha",
          duplicateOf: "ENG-21",
          issue: "ENG-1",
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      ),
      MASTER_OUTSIDE_MAP
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("refuses a Bug duplicate whose master is older than the cutoff, the same cutoff master searches use (C4)", async () => {
    await Promise.all(
      ["ENG-50", "ENG-60"].map(async (duplicateOf) => {
        const fake = linear();
        await assert.rejects(
          routeTicket(
            { duplicateOf, issue: "ENG-1", state: "Duplicate" },
            { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
          ),
          STALE_MASTER,
          duplicateOf
        );
        assert.deepEqual(fake.writes(), [], duplicateOf);
      })
    );
  });

  it("takes a fresh master passed as parent when the match's master is past the cutoff (C4)", async () => {
    const fake = linear();
    await routeTicket(
      {
        duplicateOf: "ENG-60",
        issue: "ENG-1",
        parent: "ENG-31",
        state: "Duplicate",
      },
      { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
    );
    assert.deepEqual(fake.relations, ["i-1>i-ENG-60"]);
    assert.equal(updateOf(fake)?.parentId, "i-ENG-31");
  });

  it("closes a non-Bug duplicate under a stale master without a parent (C4)", async () => {
    const fake = linear({ ticketLabels: NOT_A_BUG });
    await routeTicket(
      { duplicateOf: "ENG-60", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
    );
    assert.equal(updateOf(fake)?.parentId, undefined);
  });

  it("keeps a master inside the cutoff (C4)", async () => {
    const fake = linear();
    await routeTicket(
      { duplicateOf: "ENG-20", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
  });
});
