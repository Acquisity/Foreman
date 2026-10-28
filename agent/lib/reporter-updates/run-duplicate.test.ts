import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpsFields } from "../ops-log.js";
import { DUPLICATE_TEXT, fixedText } from "./copy.js";
import {
  fakeWriter,
  MERGE_SHA,
  merged,
  NEW_SHA,
  NOW,
  OLD_SHA,
  PR_URL,
  pullKey,
  reconcile,
  setup,
  ticket,
  waitingIssues,
} from "./fakes.js";
import { runReporterUpdates } from "./run.js";

const DAY = 86_400_000;
const MASTER_READ_FAILED = /ENG-50 read timed out/u;
const LIVE = {
  ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
  liveSha: NEW_SHA,
  pulls: { [pullKey(7)]: merged() },
};

const duplicate = (closedDaysAgo = 1) =>
  ticket({
    closedAt: new Date(NOW - closedDaysAgo * DAY).toISOString(),
    duplicateOf: "ENG-9",
    identifier: "ENG-1",
    stateName: "Duplicate",
    stateType: "canceled",
  });

const doneOriginal = (over: Parameters<typeof ticket>[0] = {}) => {
  const original = ticket({
    identifier: "ENG-9",
    labels: ["Bug"],
    stateName: "Done",
    stateType: "completed",
    ...over,
  });
  original.anchorId = null;
  return original;
};

const withLog = (s: ReturnType<typeof setup>) => {
  const events: { event: string; fields: OpsFields }[] = [];
  s.deps.log = (event, fields) => {
    events.push({ event, fields });
  };
  s.deps.now = () => NOW;
  return events;
};

describe("duplicate of an original that is Done without a linked change", () => {
  it("keeps waiting, then posts the fixed message when a pull request is linked to the original later", async () => {
    const dup = duplicate();
    dup.updatedAt = "2026-10-11T10:00:00.000Z";
    const original = doneOriginal();
    const s = setup([dup, original], { liveSha: OLD_SHA, pulls: {} });
    withLog(s);
    const run = () => runReporterUpdates(s.deps, NOW, () => NOW);
    await run();
    await run();
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: OLD_SHA, issue: "ENG-1" },
    ]);
    original.facts.pullUrls = [PR_URL];
    Object.assign(s.probe.state, LIVE);
    await run();
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT, fixedText("the export now includes every row", null)]
    );
    assert.deepEqual(waitingIssues(s.memory), []);
  });

  it("never sends the original's staff-confirmed manual change to the duplicate's reporter (cross-workspace repro)", async () => {
    const original = doneOriginal({
      closingComments: [
        {
          author: "staff",
          body: "Removed the incorrect number from workspace B only",
          createdAt: "2026-10-12T10:00:00Z",
        },
      ],
    });
    const s = setup([duplicate(), original]);
    withLog(s);
    const writer = fakeWriter({
      done: { steps: null, what: "the incorrect number has been removed" },
    });
    s.deps.write = writer.write;
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "waiting" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    assert.equal(
      writer.tasks.some((t) => t.kind === "done"),
      false,
      "the original's comments never reach the writer for the duplicate"
    );
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: OLD_SHA, issue: "ENG-1" },
    ]);
    assert.equal(
      s.memory.table.get("ENG-1|fixed")?.status,
      "waiting",
      "no claim is taken"
    );
  });

  it("posts Done when a staff comment on the duplicate itself describes the change", async () => {
    const dup = duplicate();
    dup.facts.closingComments = [
      {
        author: "staff",
        body: "Removed the wrong number from this customer's CRM too.",
        createdAt: "2026-10-12T10:00:00Z",
      },
    ];
    const s = setup([dup, doneOriginal()]);
    withLog(s);
    const writer = fakeWriter();
    s.deps.write = writer.write;
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.equal(
      s.linear.posts[1]?.body,
      "Done: that number's been removed from the CRM. Reply here if anything still looks off."
    );
    const task = writer.tasks.find((t) => t.kind === "done");
    assert.deepEqual(task && "staff" in task ? task.staff : [], [
      "Removed the wrong number from this customer's CRM too.",
    ]);
  });

  it("stops waiting and logs it 30 days after the duplicate was closed", async () => {
    const s = setup([duplicate(31), doneOriginal()]);
    const events = withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: { code: "expired", issue: "ENG-1", outcome: "skipped" },
    });
  });

  it("logs the drop when the original is Canceled", async () => {
    const s = setup([
      duplicate(),
      doneOriginal({ stateName: "Canceled", stateType: "canceled" }),
    ]);
    const events = withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: { code: "original_canceled", issue: "ENG-1", outcome: "skipped" },
    });
  });

  it("wakes a waiting duplicate with no new release once staff confirm a change on the duplicate itself", async () => {
    const dup = duplicate();
    dup.updatedAt = "2026-10-11T10:00:00.000Z";
    const original = doneOriginal({
      closingComments: [
        {
          author: "staff",
          body: "Removed the wrong number from the CRM.",
          createdAt: "2026-10-12T10:00:00Z",
        },
      ],
    });
    const s = setup([dup, original], { liveSha: OLD_SHA, pulls: {} });
    withLog(s);
    const run = () => runReporterUpdates(s.deps, NOW, () => NOW);
    await run();
    await run();
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    dup.facts.closingComments = [
      {
        author: "staff",
        body: "Removed the wrong number for this customer as well.",
        createdAt: "2026-10-12T11:00:00Z",
      },
    ];
    await run();
    assert.equal(s.linear.posts.length, 1, "nothing before the recheck time");
    s.memory.state.now += 61 * 60_000;
    await run();
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [
        DUPLICATE_TEXT,
        "Done: that number's been removed from the CRM. Reply here if anything still looks off.",
      ]
    );
  });
});

describe("the 30-day limit on every waiting duplicate", () => {
  const expired = { code: "expired", issue: "ENG-1", outcome: "skipped" };

  it("expires a duplicate past 30 days whose master cannot be read (Devin 8)", async () => {
    const dup = duplicate(31);
    dup.facts.parent = { identifier: "ENG-50", stateType: "started" };
    const s = setup([dup, doneOriginal(), ticket({ identifier: "ENG-50" })]);
    const events = withLog(s);
    await reconcile(s);
    s.linear.state.failOriginals.add("ENG-50");
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: expired,
    });
  });

  it("stops waiting on an open original 30 days after the duplicate was closed", async () => {
    const original = ticket({ identifier: "ENG-9" });
    original.anchorId = null;
    const s = setup([duplicate(31), original]);
    const events = withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: expired,
    });
  });

  it("stops waiting on an original whose fix is not live yet", async () => {
    const original = doneOriginal({ pullUrls: [PR_URL] });
    const s = setup([duplicate(31), original], {
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    const events = withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: expired,
    });
  });

  it("still posts a fix that is live on day 31", async () => {
    const s = setup(
      [duplicate(31), doneOriginal({ pullUrls: [PR_URL] })],
      LIVE
    );
    withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
  });
});

describe("a duplicate under a master (ENG-16608)", () => {
  const underMaster = () => {
    const dup = duplicate();
    dup.facts.parent = { identifier: "ENG-50", stateType: "completed" };
    const earlier = doneOriginal({
      parent: { identifier: "ENG-50", stateType: "completed" },
      stateName: "Duplicate",
      stateType: "canceled",
    });
    const master = doneOriginal({ identifier: "ENG-50", pullUrls: [PR_URL] });
    return { dup, earlier, master };
  };

  it("follows the master's fixing pull request when its match is an earlier duplicate", async () => {
    const { dup, earlier, master } = underMaster();
    const s = setup([dup, earlier, master], LIVE);
    withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT, fixedText("the export now includes every row", null)]
    );
  });

  it("drops the wait when the master itself is Canceled", async () => {
    const { dup, earlier } = underMaster();
    const master = doneOriginal({
      identifier: "ENG-50",
      stateName: "Canceled",
      stateType: "canceled",
    });
    const s = setup([dup, earlier, master]);
    const events = withLog(s);
    await reconcile(s);
    await reconcile(s);
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: { code: "original_canceled", issue: "ENG-1", outcome: "skipped" },
    });
  });

  it("posts the fix linked to the matched report when its Done master has none (CodeRabbit 3)", async () => {
    const dup = duplicate();
    dup.facts.parent = { identifier: "ENG-50", stateType: "completed" };
    const report = doneOriginal({
      parent: { identifier: "ENG-50", stateType: "completed" },
      pullUrls: [PR_URL],
    });
    const master = doneOriginal({ identifier: "ENG-50" });
    const s = setup([dup, report, master], LIVE);
    withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
  });

  it("lets a Canceled master govern, so a fixed match sends no fixed message (Devin 4)", async () => {
    const dup = duplicate();
    dup.facts.parent = { identifier: "ENG-50", stateType: "canceled" };
    const report = doneOriginal({ pullUrls: [PR_URL] });
    const master = doneOriginal({
      identifier: "ENG-50",
      stateName: "Canceled",
      stateType: "canceled",
    });
    const s = setup([dup, report, master], LIVE);
    const events = withLog(s);
    await reconcile(s);
    await reconcile(s);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    assert.deepEqual(events.at(-1), {
      event: "reporter.update.duplicate_dropped",
      fields: { code: "original_canceled", issue: "ENG-1", outcome: "skipped" },
    });
  });

  it("still posts the master's live fix when the matched report cannot be read (Devin 6)", async () => {
    const dup = duplicate();
    dup.facts.parent = { identifier: "ENG-50", stateType: "completed" };
    const master = doneOriginal({ identifier: "ENG-50", pullUrls: [PR_URL] });
    const s = setup([dup, doneOriginal(), master], LIVE);
    s.linear.state.failOriginals.add("ENG-9");
    withLog(s);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
  });

  it("waits for the master when its read fails, never deciding from the match, then sends the master's outcome (Devin 7)", async () => {
    const dup = duplicate();
    dup.facts.parent = { identifier: "ENG-50", stateType: "completed" };
    const report = doneOriginal({
      stateName: "Canceled",
      stateType: "canceled",
    });
    const master = doneOriginal({ identifier: "ENG-50", pullUrls: [PR_URL] });
    const s = setup([dup, report, master], LIVE);
    const events = withLog(s);
    await reconcile(s);
    s.linear.state.failOriginals.add("ENG-50");
    await assert.rejects(reconcile(s), MASTER_READ_FAILED);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    assert.ok(
      !events.some((e) => e.event === "reporter.update.duplicate_dropped")
    );
    s.linear.state.failOriginals.clear();
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
  });
});
