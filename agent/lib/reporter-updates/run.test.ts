import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadIncompleteError } from "../requester-reply.js";
import { commentIdFor } from "./comment-id.js";
import {
  bannedWordsIn,
  coversOf,
  fixedText,
  notFixedText,
  ownerText,
  receivedText,
  wordCount,
} from "./copy.js";
import {
  depsOf,
  fakeDeploy,
  fakeLinear,
  MERGE_SHA,
  memoryStore,
  NEW_SHA,
  OLD_SHA,
  ticket,
  waitingIssues,
} from "./fakes.js";
import { DEPLOY_REPOSITORY, type PullFacts } from "./plan.js";
import { reconcileTicket, runReporterUpdates } from "./run.js";

const PR_URL = `https://github.com/${DEPLOY_REPOSITORY}/pull/7`;
const merged = (over: Partial<PullFacts> = {}): PullFacts => ({
  mergeSha: MERGE_SHA,
  number: 7,
  repo: DEPLOY_REPOSITORY,
  state: "merged",
  ...over,
});
const pullKey = (number: number) => `${DEPLOY_REPOSITORY}#${number}`;
const NOW = Date.parse("2026-10-20T12:00:00Z");

const setup = (
  tickets = [ticket()],
  deploy: Parameters<typeof fakeDeploy>[0] = { liveSha: OLD_SHA, pulls: {} },
  over = {}
) => {
  const linear = fakeLinear(tickets);
  const probe = fakeDeploy(deploy);
  const memory = memoryStore();
  const deps = depsOf(linear.port, probe.probe, memory.store, over);
  return { deps, linear, memory, probe };
};

const reconcile = (s: ReturnType<typeof setup>, identifier = "ENG-1") =>
  reconcileTicket(identifier, s.deps, () => s.probe.probe.liveSha());

describe("received and owner messages", () => {
  it("posts one received message that names the owner, then nothing on a replay", async () => {
    const s = setup();
    const first = await reconcile(s);
    assert.deepEqual(first, { kind: "posted", stage: "received" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [receivedText("Sam")]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("posts the owner message later, once, when the owner appears after triage", async () => {
    const t = ticket({ assignee: "Aaron Fraga", stateType: "triage" });
    const s = setup([t]);
    await reconcile(s);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [receivedText(null)]
    );
    Object.assign(t.facts, { assignee: "Sam Jones", stateType: "unstarted" });
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "owner" });
    assert.equal(s.linear.posts.at(-1)?.body, ownerText("Sam"));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 2);
  });

  it("never sends a received message for a ticket that was already Done when first seen", async () => {
    const s = setup([ticket({ stateType: "completed" })], {
      liveSha: OLD_SHA,
      pulls: {},
    });
    await reconcile(s);
    assert.ok(s.linear.posts.every((p) => !p.body.includes("received")));
  });

  it("skips tickets outside the enabled channels, before the cutoff or with no thread", async () => {
    const wrongChannel = setup([ticket({ channel: "C0BBBBBBBBB" })]);
    assert.deepEqual(await reconcile(wrongChannel), {
      kind: "skipped",
      why: "channel_not_enabled",
    });
    const noChannel = setup([ticket({ channel: null })]);
    assert.equal((await reconcile(noChannel)).kind, "skipped");
    const old = setup([ticket({ createdAt: "2026-09-01T00:00:00.000Z" })]);
    assert.deepEqual(await reconcile(old), {
      kind: "skipped",
      why: "before_cutoff",
    });
    const noThread = ticket();
    noThread.anchorId = null;
    const none = setup([noThread]);
    assert.deepEqual(await reconcile(none), {
      kind: "skipped",
      why: "no_thread",
    });
    for (const s of [wrongChannel, noChannel, old, none]) {
      assert.equal(s.linear.posts.length, 0);
    }
  });
});

describe("fixed message waits for the deploy", () => {
  const doneTicket = () =>
    ticket({ pullUrls: [PR_URL], stateType: "completed" });

  it("posts nothing while the fix is merged but not live, then exactly one fixed message once it is", async () => {
    const s = setup([doneTicket()], {
      ancestors: { [`${MERGE_SHA}>${OLD_SHA}`]: false },
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    assert.deepEqual(await reconcile(s), { kind: "waiting" });
    assert.equal(s.linear.posts.length, 0);
    assert.deepEqual(await reconcile(s), { kind: "waiting" });
    assert.equal(s.linear.posts.length, 0);
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: OLD_SHA, issue: "ENG-1" },
    ]);

    s.probe.state.liveSha = NEW_SHA;
    s.probe.state.ancestors[`${MERGE_SHA}>${NEW_SHA}`] = true;
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [fixedText()]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
    assert.deepEqual(waitingIssues(s.memory), []);
  });

  it("asks GitHub whether the merge commit is an ancestor of the live commit", async () => {
    const calls: string[] = [];
    const s = setup([doneTicket()], {
      liveSha: NEW_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    const original = s.probe.probe.isAncestor;
    s.probe.probe.isAncestor = (repo, base, head) => {
      calls.push(`${repo} ${base} ${head}`);
      return original(repo, base, head);
    };
    await reconcile(s);
    assert.deepEqual(calls, [`${DEPLOY_REPOSITORY} ${MERGE_SHA} ${NEW_SHA}`]);
  });

  it("waits while the pull request is still open, even though the ticket is Done", async () => {
    const s = setup([doneTicket()], {
      liveSha: NEW_SHA,
      pulls: { [pullKey(7)]: merged({ mergeSha: null, state: "open" }) },
    });
    assert.deepEqual(await reconcile(s), { kind: "waiting" });
    assert.equal(s.linear.posts.length, 0);
    assert.equal(s.probe.state.calls.ancestor, 0);
  });

  it("follows the master: a Done master with the fix posts to the open customer ticket", async () => {
    const t = ticket({
      parent: { identifier: "ENG-9", stateType: "completed" },
      pullUrls: [PR_URL],
      stateType: "started",
    });
    const s = setup([t], {
      ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
      liveSha: NEW_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
  });

  it("does not post when the live commit is unknown", async () => {
    const s = setup([doneTicket()], {
      liveSha: null,
      pulls: { [pullKey(7)]: merged() },
    });
    assert.deepEqual(await reconcile(s), { kind: "waiting" });
    assert.equal(s.linear.posts.length, 0);
  });

  it("holds a fix in a repository with no deploy signal and a Done bug with no linked pull request", async () => {
    const other = setup(
      [
        ticket({
          pullUrls: ["https://github.com/Acquisity/other-repo/pull/3"],
          stateType: "completed",
        }),
      ],
      {
        liveSha: NEW_SHA,
        pulls: {
          "Acquisity/other-repo#3": merged({
            number: 3,
            repo: "Acquisity/other-repo",
          }),
        },
      }
    );
    assert.deepEqual(await reconcile(other), {
      kind: "held",
      why: "unsupported",
    });
    const bug = setup([ticket({ labels: ["Bug"], stateType: "completed" })]);
    assert.deepEqual(await reconcile(bug), {
      kind: "held",
      why: "no_linked_pull",
    });
    assert.equal(other.linear.posts.length + bug.linear.posts.length, 0);
  });
});

describe("not fixed message", () => {
  it("answers a duplicate once on cancel, with no deploy lookup at all", async () => {
    const t = ticket({ stateName: "Duplicate", stateType: "canceled" });
    const s = setup([t]);
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [notFixedText("duplicate")]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(s.probe.state.calls, { ancestor: 0, live: 0, pull: 0 });
  });

  it("answers a Done not-a-bug ticket once with the not-a-bug reason", async () => {
    const s = setup([
      ticket({ labels: ["User Error"], stateType: "completed" }),
    ]);
    await reconcile(s);
    await reconcile(s);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [notFixedText("not_a_bug")]
    );
    assert.deepEqual(s.probe.state.calls, { ancestor: 0, live: 0, pull: 0 });
  });
});

describe("not fixed wording does not claim more than is known", () => {
  const claims = [
    "without a change",
    "no change",
    "needed",
    "nothing is broken",
  ];

  it("says only that a cancelled bug was closed", async () => {
    const s = setup([
      ticket({ labels: ["Bug"], stateName: "Canceled", stateType: "canceled" }),
    ]);
    await reconcile(s);
    const [post] = s.linear.posts;
    assert.equal(post?.body, notFixedText("closed"));
    for (const claim of claims) {
      assert.ok(!post?.body.includes(claim), claim);
    }
  });

  it("says the same for a cancelled ticket whose linked fix did ship", async () => {
    const s = setup(
      [
        ticket({
          pullUrls: [PR_URL],
          stateName: "Canceled",
          stateType: "canceled",
        }),
      ],
      {
        ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
        liveSha: NEW_SHA,
        pulls: { [pullKey(7)]: merged() },
      }
    );
    await reconcile(s);
    const [post] = s.linear.posts;
    assert.equal(post?.body, notFixedText("closed"));
    for (const claim of claims) {
      assert.ok(!post?.body.includes(claim), claim);
    }
  });

  it("uses the same wording for a Done ticket with no code and no label", async () => {
    const s = setup([ticket({ stateType: "completed" })]);
    await reconcile(s);
    assert.equal(s.linear.posts[0]?.body, notFixedText("closed"));
  });

  it("still recognises the wording an earlier version posted", () => {
    assert.deepEqual(
      coversOf(
        "We looked into this and closed it without a change to the product. Nothing for you to do. If it still looks wrong, reply here and we'll look again."
      ),
      ["not_fixed"]
    );
  });
});

describe("once only, and never lost", () => {
  it("records a message already in the thread instead of posting it again", async () => {
    const t = ticket({ stateName: "Duplicate", stateType: "canceled" });
    t.foremanComments.push({ body: notFixedText("duplicate"), id: "existing" });
    const s = setup([t]);
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 0);
    const rows = await s.memory.store.rows("ENG-1");
    assert.deepEqual(
      rows.map((r) => [r.stage, r.status, r.commentId]),
      [["not_fixed", "sent", "existing"]]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
  });

  it("does not repeat a message when the record write failed after the post", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    s.memory.state.failNextMarkSent = true;
    await assert.rejects(reconcile(s), { message: "database unavailable" });
    assert.equal(s.linear.posts.length, 1);
    s.memory.state.now += 11 * 60_000;
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("releases the claim when the post fails, then sends it on the next run", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    s.linear.state.failNextPost = true;
    await assert.rejects(reconcile(s), { message: "Linear is unavailable" });
    assert.equal(s.linear.posts.length, 0);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "backing_off",
    });
    s.memory.state.now += 11 * 60_000;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("posts once when two runs overlap", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    const outcomes = await Promise.all([
      reconcile(s),
      reconcile(s),
      reconcile(s),
    ]);
    assert.equal(s.linear.posts.length, 1);
    assert.equal(outcomes.filter((o) => o.kind === "posted").length, 1);
  });

  it("does not take over a fresh claim, but recovers a stale one", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    await s.memory.store.claim("ENG-1", "not_fixed", "x", null);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "busy",
    });
    s.memory.state.now += 11 * 60_000;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
  });
});

describe("claims and recovery", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const settled = async () => {
    await tick();
    await tick();
    await tick();
  };

  it("records both stages of a named received message when the record write failed, and never repeats the owner", async () => {
    const s = setup([ticket()]);
    s.memory.state.failNextMarkSent = true;
    await assert.rejects(reconcile(s), { message: "database unavailable" });
    assert.equal(s.linear.posts.length, 1);
    assert.equal(s.linear.posts[0]?.body, receivedText("Sam"));
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "received",
    });
    assert.deepEqual(
      (await s.memory.store.rows("ENG-1"))
        .map((row) => [row.stage, row.status])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["owner", "sent"],
        ["received", "sent"],
      ]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("writes one comment even when a claim expires while the first write is still in flight", async () => {
    const t = ticket({ stateName: "Duplicate", stateType: "canceled" });
    const s = setup([t]);
    let release: () => void = () => undefined;
    s.linear.state.holdNextPost = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = reconcile(s);
    const firstSettled = first.then(
      () => "posted",
      (error: Error) => error.message
    );
    await settled();
    s.memory.state.now += 11 * 60_000;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    release();
    assert.equal(await firstSettled, "ENG-1: the not_fixed claim was lost.");
    assert.equal(s.linear.posts.length, 1);
    assert.deepEqual(
      (await s.memory.store.rows("ENG-1")).map((row) => row.status),
      ["sent"]
    );
  });

  it("treats a write that timed out after Linear created the comment as posted", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    s.linear.state.failAfterCreate = true;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 1);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
  });

  it("recognises a comment by its id even if its wording was edited", async () => {
    const t = ticket({ stateName: "Duplicate", stateType: "canceled" });
    t.foremanComments.push({
      body: "Edited by a person.",
      id: commentIdFor("ENG-1", "not_fixed"),
    });
    const s = setup([t]);
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 0);
  });

  it("backs off after repeated failures, says so in the log, and still delivers once the provider works again", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    s.deps.log = (event, fields) => logged.push({ event, fields });
    await [1, 2, 3, 4, 5, 6].reduce(async (previous) => {
      await previous;
      s.memory.state.now += 7 * 3_600_000;
      s.linear.state.failNextPost = true;
      await assert.rejects(reconcile(s), { message: "Linear is unavailable" });
    }, Promise.resolve());
    assert.ok(logged.length >= 2);
    assert.equal(logged[0]?.event, "reporter.update.backing_off");
    assert.equal(logged[0]?.fields.decision, "not_fixed");
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "backing_off",
    });
    s.memory.state.now += 7 * 3_600_000;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("never waits longer than six hours between attempts, however many have failed", async () => {
    const s = setup([
      ticket({ stateName: "Duplicate", stateType: "canceled" }),
    ]);
    await Array.from({ length: 30 }).reduce(async (previous) => {
      await previous;
      s.memory.state.now += 7 * 3_600_000;
      s.linear.state.failNextPost = true;
      await assert.rejects(reconcile(s), { message: "Linear is unavailable" });
    }, Promise.resolve());
    s.memory.state.now += 6 * 3_600_000 + 1;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
  });

  it("ignores a release made with a claim that is no longer current", async () => {
    const s = setup();
    const first = await s.memory.store.claim("ENG-1", "fixed", "x", null);
    s.memory.state.now += 11 * 60_000;
    const second = await s.memory.store.claim("ENG-1", "fixed", "x", null);
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      await s.memory.store.release("ENG-1", "fixed", first.token);
      assert.equal((await s.memory.store.rows("ENG-1"))[0]?.status, "claimed");
      assert.equal(
        await s.memory.store.complete(
          "ENG-1",
          "fixed",
          ["fixed"],
          "x",
          null,
          "c",
          first.token
        ),
        false
      );
    }
  });
});

describe("discovery", () => {
  const SINCE = "2026-10-01T00:00:00.000Z";
  const old = (n: number, over: Parameters<typeof ticket>[0] = {}) => {
    const t = ticket({ identifier: `ENG-${n}`, ...over });
    t.updatedAt = "2026-10-11T10:00:00.000Z";
    return t;
  };
  const run = (s: ReturnType<typeof setup>, at = NOW) =>
    runReporterUpdates(s.deps, at, () => at);

  it("finds an eligible ticket that was last changed long before the schedule was switched on", async () => {
    const s = setup([old(1)]);
    const report = await run(s);
    assert.equal(s.linear.state.discoveries[0]?.updatedSince, SINCE);
    assert.equal(s.linear.state.discoveries[0]?.createdAfter, SINCE);
    assert.equal(report.errors.length, 0);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
  });

  it("looks only at changes since the last complete listing, less a safety overlap", async () => {
    const s = setup([old(1)]);
    await run(s);
    assert.equal(s.memory.state.cursor, NOW - 600_000);
    await run(s, NOW + 300_000);
    assert.equal(
      s.linear.state.discoveries[1]?.updatedSince,
      new Date(NOW - 600_000).toISOString()
    );
  });

  it("finds a report whose master was completed even though the report itself did not change", async () => {
    const child = old(1, {
      parent: { identifier: "ENG-9", stateType: "completed" },
      pullUrls: [PR_URL],
      stateType: "started",
    });
    child.parentUpdatedAt = new Date(NOW - 60_000).toISOString();
    const s = setup([child], {
      ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
      liveSha: NEW_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    s.memory.state.cursor = NOW - 3_600_000;
    s.memory.table.set("ENG-1|received", {
      attempts: 1,
      checkedSha: null,
      claimedAt: 0,
      commentId: "c",
      message: "",
      stage: "received",
      status: "sent",
      token: null,
    });
    await run(s);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [fixedText()]
    );
  });

  it("does not rediscover an unchanged report whose master is also unchanged", async () => {
    const child = old(1, {
      parent: { identifier: "ENG-9", stateType: "completed" },
    });
    child.parentUpdatedAt = "2026-10-05T00:00:00.000Z";
    const s = setup([child]);
    s.memory.state.cursor = NOW - 3_600_000;
    await run(s);
    assert.equal(s.linear.posts.length, 0);
  });

  it("keeps a failed delivery until it succeeds, even when the ticket is never listed again", async () => {
    const s = setup([
      old(1, { stateName: "Duplicate", stateType: "canceled" }),
    ]);
    s.linear.state.failNextPost = true;
    const first = await run(s);
    assert.equal(first.errors.length, 1);
    assert.equal(s.linear.posts.length, 0);
    s.memory.state.now += 11 * 60_000;
    const second = await run(s, NOW + 300_000);
    assert.equal(second.errors.length, 0);
    assert.equal(
      s.linear.state.discoveries[1]?.updatedSince,
      new Date(NOW - 600_000).toISOString()
    );
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
    assert.equal(s.memory.pending.size, 0);
  });

  it("retries a ticket whose claim expired after a crash, once the claim has lapsed", async () => {
    const s = setup([
      old(1, { stateName: "Duplicate", stateType: "canceled" }),
    ]);
    await s.memory.store.claim("ENG-1", "not_fixed", "x", null);
    await s.memory.store.enqueue(["ENG-1"]);
    await run(s);
    assert.equal(s.linear.posts.length, 0);
    assert.equal(s.memory.pending.has("ENG-1"), true);
    s.memory.state.now += 11 * 60_000;
    await run(s, NOW + 300_000);
    assert.equal(s.linear.posts.length, 1);
    assert.equal(s.memory.pending.size, 0);
  });

  it("keeps tickets over the post cap for the next run instead of dropping them", async () => {
    const tickets = [1, 2, 3, 4].map((n) =>
      old(n, { stateName: "Duplicate", stateType: "canceled" })
    );
    const s = setup(tickets, { liveSha: OLD_SHA, pulls: {} }, { maxPosts: 2 });
    await run(s);
    assert.equal(s.linear.posts.length, 2);
    assert.equal(s.memory.pending.size, 2);
    await run(s, NOW + 300_000);
    assert.equal(s.linear.posts.length, 4);
    assert.equal(s.memory.pending.size, 0);
  });

  it("does not move the cursor when the queue could not be saved or Linear is down", async () => {
    const unsaved = setup([old(1)]);
    unsaved.memory.state.failNextEnqueue = true;
    const failed = await run(unsaved);
    assert.equal(unsaved.memory.state.cursor, null);
    assert.ok(failed.errors.some((e) => e.startsWith("discovery:")));

    const down = setup([old(1)]);
    down.linear.state.discoverFails = true;
    await run(down);
    assert.equal(down.memory.state.cursor, null);
  });

  it("covers a backlog bigger than one run's page budget over several runs, resuming where the last one stopped", async () => {
    const tickets = [1, 2, 3, 4, 5].map((n) =>
      old(n, { stateName: "Duplicate", stateType: "canceled" })
    );
    const s = setup(tickets, { liveSha: OLD_SHA, pulls: {} });
    s.linear.state.discoverPageSize = 2;
    await run(s);
    assert.equal(s.memory.state.cursor, null);
    assert.deepEqual(s.memory.state.sweep, {
      after: "2",
      since: Date.parse(SINCE),
      startedAt: NOW,
    });
    await run(s, NOW + 300_000);
    assert.equal(s.memory.state.cursor, null);
    await run(s, NOW + 600_000);
    assert.deepEqual(
      s.linear.state.discoveries.map((d) => d.after),
      [null, "2", "4"]
    );
    assert.ok(
      s.linear.state.discoveries.every((d) => d.updatedSince === SINCE),
      "every page of one sweep uses the same window"
    );
    assert.equal(s.memory.state.sweep, null);
    assert.equal(s.memory.state.cursor, NOW - 600_000);
    assert.deepEqual(
      s.linear.posts
        .map((p) => p.identifier)
        .sort((a, b) => a.localeCompare(b)),
      ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]
    );
  });

  it("starts the next sweep from when the finished one began, so nothing changed in between is missed", async () => {
    const s = setup(
      [1, 2, 3].map((n) =>
        old(n, { stateName: "Duplicate", stateType: "canceled" })
      ),
      { liveSha: OLD_SHA, pulls: {} }
    );
    s.linear.state.discoverPageSize = 2;
    await run(s);
    await run(s, NOW + 300_000);
    await run(s, NOW + 600_000);
    assert.equal(
      s.linear.state.discoveries[2]?.after,
      null,
      "the finished sweep is followed by a fresh one"
    );
    assert.equal(
      s.linear.state.discoveries[2]?.updatedSince,
      new Date(NOW - 600_000).toISOString()
    );
  });

  it("gives up on a sweep that is a day old and starts again from the saved cursor", async () => {
    const s = setup(
      [1, 2, 3].map((n) =>
        old(n, { stateName: "Duplicate", stateType: "canceled" })
      ),
      { liveSha: OLD_SHA, pulls: {} }
    );
    s.linear.state.discoverPageSize = 2;
    await run(s);
    await run(s, NOW + 2 * 86_400_000);
    assert.equal(s.linear.state.discoveries[1]?.after, null);
  });

  it("keeps a ticket whose thread is too long to read pending and visible as an error, without blocking the others", async () => {
    const s = setup([
      old(1),
      old(2, { stateName: "Duplicate", stateType: "canceled" }),
    ]);
    const original = s.linear.port.readTicket;
    s.linear.port.readTicket = (identifier) =>
      identifier === "ENG-1"
        ? Promise.reject(new ThreadIncompleteError("ENG-1"))
        : original(identifier);
    const report = await run(s);
    assert.equal(report.errors.length, 1);
    assert.ok(report.errors[0]?.startsWith("ENG-1: ENG-1 has more than 100"));
    assert.equal(s.memory.pending.get("ENG-1")?.attempts, 1);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-2"]
    );
    assert.equal(s.memory.pending.has("ENG-2"), false);
  });

  it("retries that ticket under the same backoff, and delivers once the thread can be read", async () => {
    const s = setup([
      old(1, { stateName: "Duplicate", stateType: "canceled" }),
    ]);
    const original = s.linear.port.readTicket;
    s.linear.port.readTicket = () =>
      Promise.reject(new ThreadIncompleteError("ENG-1"));
    await run(s);
    s.linear.port.readTicket = original;
    s.memory.state.now += 11 * 60_000;
    await run(s, NOW + 300_000);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
    assert.equal(s.memory.pending.size, 0);
  });

  it("backs off a ticket that keeps failing to read, then reads it again once time has passed", async () => {
    const s = setup([old(1)]);
    const original = s.linear.port.readTicket;
    s.linear.port.readTicket = () =>
      Promise.reject(new Error("Linear is unavailable"));
    await Array.from({ length: 25 }).reduce<Promise<unknown>>(
      (previous, _, i) =>
        previous.then(() => {
          s.memory.state.now += 7 * 3_600_000;
          return run(s, NOW + i * 300_000);
        }),
      Promise.resolve()
    );
    assert.ok((s.memory.pending.get("ENG-1")?.attempts ?? 0) >= 20);
    s.linear.port.readTicket = original;
    s.memory.state.now += 7 * 3_600_000;
    await run(s, NOW + 30 * 300_000);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
    assert.equal(s.memory.pending.size, 0);
  });

  it("retries at once when the ticket changes again, without waiting out the backoff", async () => {
    const t = old(1, { stateName: "Duplicate", stateType: "canceled" });
    const s = setup([t]);
    s.linear.state.failNextPost = true;
    await run(s);
    assert.equal(s.linear.posts.length, 0);
    t.updatedAt = new Date(NOW + 60_000).toISOString();
    await run(s, NOW + 300_000);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
  });
});

describe("run over several tickets", () => {
  const five = () =>
    [1, 2, 3, 4, 5].map((n) =>
      ticket({
        identifier: `ENG-${n}`,
        pullUrls: [`https://github.com/${DEPLOY_REPOSITORY}/pull/${n}`],
        stateType: "completed",
      })
    );
  const fiveDeploy = (live: string, ancestor: boolean) => ({
    ancestors: Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [
        `${MERGE_SHA.slice(0, -1)}${n}>${live}`,
        ancestor,
      ])
    ),
    liveSha: live,
    pulls: Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [
        pullKey(n),
        merged({ mergeSha: `${MERGE_SHA.slice(0, -1)}${n}`, number: n }),
      ])
    ),
  });

  it("gives each of five Done tickets one fixed message, only after the deploy, and nothing on replay", async () => {
    const s = setup(five(), fiveDeploy(OLD_SHA, false));
    const before = await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(before.errors.length, 0);
    assert.equal(s.linear.posts.length, 0);
    assert.equal(waitingIssues(s.memory).length, 5);

    const unchanged = await runReporterUpdates(
      s.deps,
      NOW + 300_000,
      () => NOW + 300_000
    );
    assert.equal(s.linear.posts.length, 0);
    assert.equal(unchanged.errors.length, 0);

    s.probe.state.liveSha = NEW_SHA;
    for (const n of [1, 2, 3, 4, 5]) {
      s.probe.state.ancestors[`${MERGE_SHA.slice(0, -1)}${n}>${NEW_SHA}`] =
        true;
    }
    const after = await runReporterUpdates(
      s.deps,
      NOW + 600_000,
      () => NOW + 600_000
    );
    assert.equal(after.errors.length, 0);
    assert.equal(s.linear.posts.length, 5);
    assert.deepEqual(
      s.linear.posts
        .map((p) => p.identifier)
        .sort((a, b) => a.localeCompare(b)),
      ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]
    );
    assert.ok(s.linear.posts.every((p) => p.body === fixedText()));

    const replay = await runReporterUpdates(
      s.deps,
      NOW + 900_000,
      () => NOW + 900_000
    );
    assert.equal(s.linear.posts.length, 5);
    assert.equal(
      replay.outcomes.filter((o) => o.outcome.kind === "posted").length,
      0
    );
    const again = await runReporterUpdates(
      s.deps,
      NOW + 1_200_000,
      () => NOW + 1_200_000
    );
    assert.equal(again.errors.length, 0);
    assert.equal(s.linear.posts.length, 5);
  });

  it("rechecks a waiting ticket that has dropped out of the recent list when the live commit changes", async () => {
    const tickets = five().slice(0, 1);
    const s = setup(tickets, fiveDeploy(OLD_SHA, false));
    await runReporterUpdates(s.deps, NOW, () => NOW);
    s.linear.port.discover = () =>
      Promise.resolve({ complete: true, identifiers: [] });
    const readsBefore = s.linear.state.reads;
    await runReporterUpdates(s.deps, NOW + 300_000, () => NOW + 300_000);
    assert.equal(s.linear.state.reads, readsBefore);
    s.probe.state.liveSha = NEW_SHA;
    s.probe.state.ancestors[`${MERGE_SHA.slice(0, -1)}1>${NEW_SHA}`] = true;
    await runReporterUpdates(s.deps, NOW + 600_000, () => NOW + 600_000);
    assert.equal(s.linear.posts.length, 1);
    assert.equal(s.linear.posts[0]?.body, fixedText());
  });

  it("keeps going when one ticket fails and reports it", async () => {
    const tickets = five();
    const s = setup(tickets, {
      ...fiveDeploy(NEW_SHA, true),
      pulls: {
        ...fiveDeploy(NEW_SHA, true).pulls,
        [pullKey(2)]: undefined as never,
      },
    });
    delete (s.probe.state.pulls as Record<string, unknown>)[pullKey(2)];
    const report = await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(report.errors.length, 1);
    assert.ok(report.errors[0]?.startsWith("ENG-2:"));
    assert.equal(s.linear.posts.length, 4);
  });

  it("stops posting at the per-run cap", async () => {
    const tickets = [1, 2, 3, 4].map((n) =>
      ticket({
        identifier: `ENG-${n}`,
        stateName: "Duplicate",
        stateType: "canceled",
      })
    );
    const s = setup(tickets, { liveSha: OLD_SHA, pulls: {} }, { maxPosts: 2 });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(s.linear.posts.length, 2);
    await runReporterUpdates(s.deps, NOW + 300_000, () => NOW + 300_000);
    assert.equal(s.linear.posts.length, 4);
  });

  it("stops starting new tickets once the run deadline has passed", async () => {
    const tickets = [1, 2, 3].map((n) =>
      ticket({
        identifier: `ENG-${n}`,
        stateName: "Duplicate",
        stateType: "canceled",
      })
    );
    const s = setup(
      tickets,
      { liveSha: OLD_SHA, pulls: {} },
      { runDeadlineMs: 1000 }
    );
    let now = NOW;
    const original = s.linear.port.postUnderAnchor;
    s.linear.port.postUnderAnchor = (...args) => {
      now += 600;
      return original(...args);
    };
    await runReporterUpdates(s.deps, NOW, () => now);
    assert.equal(s.linear.posts.length, 2);
  });

  it("only ever posts messages that are short and free of banned words", async () => {
    const tickets = [
      ticket({ identifier: "ENG-1" }),
      ticket({
        identifier: "ENG-2",
        stateName: "Duplicate",
        stateType: "canceled",
      }),
      ticket({
        identifier: "ENG-3",
        labels: ["User Error"],
        stateType: "completed",
      }),
      ticket({ identifier: "ENG-4", stateType: "completed" }),
    ];
    const s = setup(tickets);
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(s.linear.posts.length, 4);
    for (const post of s.linear.posts) {
      assert.ok(wordCount(post.body) <= 50, post.body);
      assert.deepEqual(bannedWordsIn(post.body), [], post.body);
    }
  });
});
