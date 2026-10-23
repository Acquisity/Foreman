import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bannedWordsIn,
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
    assert.deepEqual(await s.memory.store.listWaiting(), [
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
    assert.deepEqual(await s.memory.store.listWaiting(), []);
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
      why: "claimed_elsewhere",
    });
    s.memory.state.now += 11 * 60_000;
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
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
    const before = await runReporterUpdates(s.deps, NOW);
    assert.equal(before.errors.length, 0);
    assert.equal(s.linear.posts.length, 0);
    assert.equal((await s.memory.store.listWaiting()).length, 5);

    const unchanged = await runReporterUpdates(s.deps, NOW + 300_000);
    assert.equal(s.linear.posts.length, 0);
    assert.equal(unchanged.errors.length, 0);

    s.probe.state.liveSha = NEW_SHA;
    for (const n of [1, 2, 3, 4, 5]) {
      s.probe.state.ancestors[`${MERGE_SHA.slice(0, -1)}${n}>${NEW_SHA}`] =
        true;
    }
    const after = await runReporterUpdates(s.deps, NOW + 600_000);
    assert.equal(after.errors.length, 0);
    assert.equal(s.linear.posts.length, 5);
    assert.deepEqual(
      s.linear.posts
        .map((p) => p.identifier)
        .sort((a, b) => a.localeCompare(b)),
      ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]
    );
    assert.ok(s.linear.posts.every((p) => p.body === fixedText()));

    const replay = await runReporterUpdates(s.deps, NOW + 900_000);
    assert.equal(s.linear.posts.length, 5);
    assert.equal(
      replay.outcomes.filter((o) => o.outcome.kind === "posted").length,
      0
    );
    const again = await runReporterUpdates(s.deps, NOW + 1_200_000);
    assert.equal(again.errors.length, 0);
    assert.equal(s.linear.posts.length, 5);
  });

  it("rechecks a waiting ticket that has dropped out of the recent list when the live commit changes", async () => {
    const tickets = five().slice(0, 1);
    const s = setup(tickets, fiveDeploy(OLD_SHA, false));
    await runReporterUpdates(s.deps, NOW);
    s.linear.port.recentIdentifiers = () => Promise.resolve([]);
    const readsBefore = s.linear.state.reads;
    await runReporterUpdates(s.deps, NOW + 300_000);
    assert.equal(s.linear.state.reads, readsBefore);
    s.probe.state.liveSha = NEW_SHA;
    s.probe.state.ancestors[`${MERGE_SHA.slice(0, -1)}1>${NEW_SHA}`] = true;
    await runReporterUpdates(s.deps, NOW + 600_000);
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
    const report = await runReporterUpdates(s.deps, NOW);
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
    await runReporterUpdates(s.deps, NOW);
    assert.equal(s.linear.posts.length, 2);
    await runReporterUpdates(s.deps, NOW + 300_000);
    assert.equal(s.linear.posts.length, 4);
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
    await runReporterUpdates(s.deps, NOW);
    assert.equal(s.linear.posts.length, 4);
    for (const post of s.linear.posts) {
      assert.ok(wordCount(post.body) <= 50, post.body);
      assert.deepEqual(bannedWordsIn(post.body), [], post.body);
    }
  });
});
