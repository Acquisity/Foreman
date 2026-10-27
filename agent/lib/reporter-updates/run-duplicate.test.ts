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

  it("posts the Done message when a staff comment on the original describes the change", async () => {
    const original = doneOriginal({
      closingComments: [
        {
          author: "staff",
          body: "Removed the wrong number from the CRM.",
          createdAt: "2026-10-12T10:00:00Z",
        },
      ],
    });
    const s = setup([duplicate(), original]);
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
      "Removed the wrong number from the CRM.",
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
});
