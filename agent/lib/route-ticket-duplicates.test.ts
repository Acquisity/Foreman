import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeTicket } from "./route-ticket.js";
import { type FakeIssue, fakeLinear } from "./route-ticket-fixtures.js";

const ANUJ = { id: "u-anuj", name: "Anuj Bhatt" };
const GONE = { id: "u-gone", name: "Pieter Venter" };
const FRESH = "2026-10-20T00:00:00.000Z";
const STALE = "2026-08-01T00:00:00.000Z";
const CUTOFF = "2026-09-28T00:00:00.000Z";

/**
 * ENG-30 and ENG-31 are masters (they carry the master template's Regression
 * seam section), ENG-20 a report under ENG-30, ENG-40 a lone report, ENG-45 a
 * lone report the unproven branch left with no labels, ENG-46 a master made by
 * hand (no marker) already parenting report ENG-47, ENG-48 an old report, ENG-50 a master created before the cutoff with report ENG-60 under
 * it, and ENG-70 a master held outside the owner map with report ENG-21.
 */
const ISSUES: Record<string, FakeIssue> = {
  "ENG-20": { labels: ["Customer reported"], parent: "ENG-30" },
  "ENG-21": { labels: ["Customer reported"], parent: "ENG-70" },
  "ENG-22": {
    assignee: { id: "u-aaron", name: "Aaron Fraga" },
    labels: ["Customer reported"],
    parent: "ENG-30",
  },
  "ENG-30": { assignee: ANUJ, createdAt: FRESH, master: true },
  "ENG-31": { assignee: ANUJ, createdAt: FRESH, master: true },
  "ENG-40": { labels: ["intercom-sourced", "Customer reported"] },
  "ENG-45": { createdAt: FRESH },
  "ENG-46": { assignee: ANUJ, createdAt: FRESH },
  "ENG-47": { labels: ["Customer reported"], parent: "ENG-46" },
  "ENG-48": { createdAt: STALE, labels: ["Customer reported"] },
  "ENG-50": { assignee: ANUJ, createdAt: STALE, master: true },
  "ENG-51": { createdAt: STALE, master: true, parent: "ENG-31" },
  "ENG-60": { labels: ["Customer reported"], parent: "ENG-50" },
  "ENG-70": { assignee: GONE, createdAt: FRESH, master: true },
  "ENG-77": { createdAt: FRESH },
};

/** ENG-1 without the Bug label: an explanation's duplicate. */
const NOT_A_BUG = [{ id: "l-cr", name: "Customer reported" }];

const GROUPING = { id: "l-grouping", name: "Needs grouping" };

const linear = (over: Parameters<typeof fakeLinear>[0] = {}) =>
  fakeLinear({ issues: ISSUES, teamLabels: [GROUPING], ...over });

/** A report left open for grouping: related to its match, no state, no parent, the grouping label. */
const leftOpen = async (
  fake: ReturnType<typeof fakeLinear>,
  routed: Promise<{ grouping: string | null; warnings: string[] }>,
  match: string,
  why: RegExp
) => {
  const result = await routed;
  assert.deepEqual(fake.relations, [`i-1>i-${match}`]);
  assert.deepEqual(fake.relationTypes, ["related"]);
  const update = fake.updates()[0]?.variables.input as Record<string, unknown>;
  assert.equal(update.stateId, "s-backlog");
  assert.equal(update.parentId, undefined);
  assert.ok((update.labelIds as string[]).includes("l-grouping"));
  assert.equal(result.grouping, "needs-grouping");
  assert.match(result.warnings.join(" "), why);
};

const updateOf = (fake: ReturnType<typeof fakeLinear>) =>
  fake.updates()[0]?.variables.input as Record<string, unknown> | undefined;

const NO_MASTER = /ENG-40 is not a master and is not under one/u;
const MAKE_MASTER = /create the master through engineering-handoff/u;
const WRONG_PARENT =
  /ENG-20 belongs under its master ENG-30, not ENG-77, so nothing was written/u;
const RELATION_NOT_RECORDED =
  /Nothing was written: the duplicate relation to ENG-9 was not recorded/u;
const MASTER_OUTSIDE_MAP =
  /ENG-70 is held by Pieter Venter, who is not in the owner map, so nothing was written/u;
const UNLABELLED_NOT_MASTER = /ENG-45 is not a master and is not under one/u;
const OLD_PARENT =
  /ENG-50 was created before 2026-09-28T00:00:00.000Z, so it cannot take new reports and nothing was written/u;
const STALE_MASTER_RETRY =
  /relate ENG-50 for history, call route_ticket with issue ENG-50 and parent set to the new master, then call this again with duplicateOf ENG-50, parent the new master and inheritAssigneeFrom the new master\./u;
const STALE_MATCH_NOT_UNDER =
  /ENG-60 is not under ENG-31, so nothing was written/u;
const MATCH_NOT_UNDER = /ENG-40 is not under ENG-31, so nothing was written/u;
const PARENT_NOT_MASTER = /ENG-40 is not a master, so nothing was written/u;
const NOT_A_MASTER_PARENT = /ENG-48 is not a master, so nothing was written/u;
const RETRY_FROM_MASTER =
  /Call route_ticket again without duplicateOf, with parent ENG-30 and inheritAssigneeFrom ENG-30/u;
const STALE_MASTER =
  /ENG-50 was created before 2026-09-28T00:00:00.000Z, so it cannot take new reports\. Create a new master/u;

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

  it("leaves a Bug duplicate of a lone report open for grouping and says how to make the master (ENG-17138)", async () => {
    const fake = linear();
    await leftOpen(
      fake,
      routeTicket(
        { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      ),
      "ENG-40",
      MAKE_MASTER
    );
  });

  it("never closes a non-Bug duplicate of a lone report: it stays open, related and labelled for grouping (ENG-17138)", async () => {
    const fake = linear({ ticketLabels: NOT_A_BUG });
    await leftOpen(
      fake,
      routeTicket(
        { duplicateOf: "ENG-40", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      ),
      "ENG-40",
      NO_MASTER
    );
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
  it("tells a ticket labelled Bug, or gaining the label, how to make its master, even when no decision says Bug (C1)", async () => {
    const adding = linear({ ticketLabels: NOT_A_BUG });
    await leftOpen(
      adding,
      routeTicket(
        {
          addLabels: ["Bug"],
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          state: "Duplicate",
        },
        { client: adding.fetchStub }
      ),
      "ENG-40",
      MAKE_MASTER
    );
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

  it("does not close a duplicate whose master is older than the cutoff, the same cutoff master searches use (C4)", async () => {
    await Promise.all(
      ["ENG-50", "ENG-60"].map(async (duplicateOf) => {
        const fake = linear();
        await leftOpen(
          fake,
          routeTicket(
            { duplicateOf, issue: "ENG-1", state: "Duplicate" },
            { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
          ),
          duplicateOf,
          STALE_MASTER
        );
      })
    );
  });

  it("refuses a fresh master passed as parent while the match still sits under its stale master (C4, R1)", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-60",
          issue: "ENG-1",
          parent: "ENG-31",
          state: "Duplicate",
        },
        { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
      ),
      STALE_MATCH_NOT_UNDER
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("leaves a non-Bug duplicate under a stale master open for grouping instead of closing it unparented (C4)", async () => {
    const fake = linear({ ticketLabels: NOT_A_BUG });
    await leftOpen(
      fake,
      routeTicket(
        { duplicateOf: "ENG-60", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
      ),
      "ENG-60",
      STALE_MASTER
    );
  });

  it("keeps a master inside the cutoff (C4)", async () => {
    const fake = linear();
    await routeTicket(
      { duplicateOf: "ENG-20", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
  });

  it("refuses a report passed as the parent of a Bug duplicate, so it cannot close without a master (C1)", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          parent: "ENG-40",
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      ),
      PARENT_NOT_MASTER
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("refuses a master passed as the parent of a Bug duplicate until the matched report is under it, so neither report is left detached (R1)", async () => {
    const fake = linear();
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          parent: "ENG-31",
          state: "Duplicate",
        },
        { client: fake.fetchStub }
      ),
      MATCH_NOT_UNDER
    );
    assert.deepEqual(fake.writes(), []);
  });

  it("inherits the owner of the master it parents the duplicate under, not the match's (Devin 1)", async () => {
    const fake = linear();
    await routeTicket(
      {
        duplicateOf: "ENG-22",
        inheritAssigneeFrom: "ENG-22",
        issue: "ENG-1",
        state: "Duplicate",
      },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-30");
    assert.equal(updateOf(fake)?.assigneeId, "u-anuj");
  });

  it("tells a retry after a recorded relation to inherit from the master, so the match's owner never lands (R2)", async () => {
    const fake = linear({ updateFailures: 1 });
    const first = {
      duplicateOf: "ENG-22",
      inheritAssigneeFrom: "ENG-22",
      issue: "ENG-1",
      state: "Duplicate",
    };
    const refusal = await routeTicket(first, { client: fake.fetchStub }).then(
      () => "",
      (error: Error) => error.message
    );
    assert.match(refusal, RETRY_FROM_MASTER);
    await routeTicket(
      {
        inheritAssigneeFrom: "ENG-30",
        issue: "ENG-1",
        parent: "ENG-30",
        state: "Duplicate",
      },
      { client: fake.fetchStub }
    );
    const landed = fake.updates().at(-1)?.variables.input as Record<
      string,
      unknown
    >;
    assert.equal(landed.parentId, "i-ENG-30");
    assert.equal(landed.assigneeId, "u-anuj");
  });

  it("never takes an unlabelled report for a master: only the master template's Regression seam section marks one (R1)", async () => {
    const fake = linear();
    await leftOpen(
      fake,
      routeTicket(
        { duplicateOf: "ENG-45", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      ),
      "ENG-45",
      UNLABELLED_NOT_MASTER
    );
  });

  it("recognises a master engineering-handoff made by its Regression seam section (R1)", async () => {
    const fake = linear();
    await routeTicket(
      { duplicateOf: "ENG-31", issue: "ENG-1", state: "Duplicate" },
      { client: fake.fetchStub }
    );
    assert.equal(updateOf(fake)?.parentId, "i-ENG-31");
  });

  it("accepts a master made by hand without the marker once it parents a report (R1)", async () => {
    for (const [duplicateOf, parent] of [
      ["ENG-46", "i-ENG-46"],
      ["ENG-47", "i-ENG-46"],
    ]) {
      const fake = linear();
      // biome-ignore lint/performance/noAwaitInLoops: each case reads its own fake in turn.
      await routeTicket(
        { duplicateOf, issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub }
      );
      assert.equal(updateOf(fake)?.parentId, parent, duplicateOf);
    }
  });

  it("applies the session cutoff to an explicit parent, and refuses one that is no master, for every classification (Devin 9)", async () => {
    const stale = linear({ ticketLabels: NOT_A_BUG });
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-60",
          issue: "ENG-1",
          parent: "ENG-50",
          state: "Duplicate",
        },
        { client: stale.fetchStub, mastersCreatedAfter: CUTOFF }
      ),
      OLD_PARENT
    );
    const report = linear({ ticketLabels: NOT_A_BUG });
    await assert.rejects(
      routeTicket(
        {
          duplicateOf: "ENG-40",
          issue: "ENG-1",
          parent: "ENG-48",
          state: "Duplicate",
        },
        { client: report.fetchStub, mastersCreatedAfter: CUTOFF }
      ),
      NOT_A_MASTER_PARENT
    );
    assert.deepEqual([...stale.writes(), ...report.writes()], []);
  });

  it("gives the exact retry when the match is itself a master past the cutoff (R3)", async () => {
    const fake = linear();
    await leftOpen(
      fake,
      routeTicket(
        { duplicateOf: "ENG-50", issue: "ENG-1", state: "Duplicate" },
        { client: fake.fetchStub, mastersCreatedAfter: CUTOFF }
      ),
      "ENG-50",
      STALE_MASTER_RETRY
    );
    // The retry it names, once the stale master (ENG-51) sits under ENG-31.
    const retried = linear();
    await routeTicket(
      {
        duplicateOf: "ENG-51",
        inheritAssigneeFrom: "ENG-31",
        issue: "ENG-1",
        parent: "ENG-31",
        state: "Duplicate",
      },
      { client: retried.fetchStub, mastersCreatedAfter: CUTOFF }
    );
    assert.equal(updateOf(retried)?.parentId, "i-ENG-31");
  });
});
