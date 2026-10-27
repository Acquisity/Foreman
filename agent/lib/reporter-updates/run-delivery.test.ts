import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentIdFor } from "./comment-id.js";
import {
  bannedWordsIn,
  coversOf,
  MAX_UPDATE_WORDS,
  notFixedText,
  PAST_TEXTS,
  wordCount,
} from "./copy.js";
import {
  FIXED,
  MERGE_SHA,
  merged,
  NEW_SHA,
  NOW,
  OLD_SHA,
  PR_URL,
  pullKey,
  RECEIVED,
  reconcile,
  SANDBOX,
  setup,
  ticket,
  waitingIssues,
} from "./fakes.js";
import { DEPLOY_REPOSITORY } from "./plan.js";
import { runReporterUpdates } from "./run.js";

describe("received message", () => {
  it("posts one received message with the written phrase and no owner, then nothing on a replay", async () => {
    const s = setup();
    const first = await reconcile(s);
    assert.deepEqual(first, { kind: "posted", stage: "received" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [RECEIVED]
    );
    assert.ok(!RECEIVED.includes("Sam"));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
  });

  it("never posts an owner message, even when an owner is assigned after triage", async () => {
    const t = ticket({ assignee: null, stateType: "triage" });
    const s = setup([t]);
    await reconcile(s);
    Object.assign(t.facts, { assignee: "Sam Jones", stateType: "unstarted" });
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [RECEIVED]
    );
  });

  it("falls back to the plain received line when the written phrase names the owner", async () => {
    const s = setup();
    s.deps.write = () =>
      Promise.resolve({ steps: null, what: "the export Sam is fixing" });
    await reconcile(s);
    assert.equal(
      s.linear.posts[0]?.body,
      "Thanks, got it. We're looking into this and will reply here when we know more."
    );
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

  it("never answers a Done ticket with no code as fixed, done or closed when nothing describes a change", async () => {
    const s = setup([ticket({ stateType: "completed" })]);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "no_evidence_of_change",
    });
    assert.equal(s.linear.posts.length, 0);
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
    t.foremanComments.push({
      body: PAST_TEXTS.not_fixed[1] ?? "",
      id: "existing",
    });
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
    assert.partialDeepStrictEqual(await reconcile(s), {
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
    assert.partialDeepStrictEqual(await reconcile(s), {
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

  it("records the received message when the record write failed, and never repeats it", async () => {
    const s = setup([ticket()]);
    s.memory.state.failNextMarkSent = true;
    await assert.rejects(reconcile(s), { message: "database unavailable" });
    assert.equal(s.linear.posts.length, 1);
    assert.equal(s.linear.posts[0]?.body, RECEIVED);
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "received",
    });
    assert.deepEqual(
      (await s.memory.store.rows("ENG-1"))
        .map((row) => [row.stage, row.status])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [["received", "sent"]]
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
    assert.partialDeepStrictEqual(await reconcile(s), {
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

describe("a thread the receiver would not deliver to", () => {
  const SINCE_NOW = NOW;
  const stuck = () => {
    const t = ticket({ stateName: "Duplicate", stateType: "canceled" });
    t.updatedAt = new Date(NOW - 60_000).toISOString();
    t.undeliverable = [SANDBOX, "C0YYYYYYYYY"];
    return t;
  };

  it("posts nothing, records nothing as sent, logs it, and keeps the ticket pending", async () => {
    const t = stuck();
    const s = setup([t]);
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    s.deps.log = (event, fields) => logged.push({ event, fields });
    const report = await runReporterUpdates(s.deps, SINCE_NOW, () => SINCE_NOW);
    assert.equal(s.linear.posts.length, 0);
    assert.deepEqual(await s.memory.store.rows("ENG-1"), []);
    assert.equal(s.memory.pending.has("ENG-1"), true);
    assert.equal(report.errors.length, 0);
    assert.deepEqual(
      report.outcomes.map((o) => o.outcome),
      [{ kind: "skipped", why: "undeliverable" }]
    );
    assert.equal(logged[0]?.event, "reporter.update.undeliverable");
  });

  it("delivers once the ticket's Ask link points at its own thread again", async () => {
    const t = stuck();
    const s = setup([t]);
    await runReporterUpdates(s.deps, SINCE_NOW, () => SINCE_NOW);
    t.undeliverable = null;
    t.updatedAt = new Date(NOW + 200_000).toISOString();
    await runReporterUpdates(s.deps, NOW + 300_000, () => NOW + 300_000);
    assert.deepEqual(
      s.linear.posts.map((p) => p.identifier),
      ["ENG-1"]
    );
  });

  it("stays quiet about a ticket none of whose threads are in an enabled channel", async () => {
    const t = stuck();
    t.undeliverable = ["C0XXXXXXXXX"];
    const s = setup([t]);
    const logged: string[] = [];
    s.deps.log = (event) => logged.push(event);
    await runReporterUpdates(s.deps, SINCE_NOW, () => SINCE_NOW);
    assert.deepEqual(logged, []);
    assert.equal(s.linear.posts.length, 0);
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
    assert.ok(s.linear.posts.every((p) => p.body === FIXED));

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
    s.linear.port.discover = () => Promise.resolve({ next: null, tickets: [] });
    const readsBefore = s.linear.state.reads;
    await runReporterUpdates(s.deps, NOW + 300_000, () => NOW + 300_000);
    assert.equal(s.linear.state.reads, readsBefore);
    s.probe.state.liveSha = NEW_SHA;
    s.probe.state.ancestors[`${MERGE_SHA.slice(0, -1)}1>${NEW_SHA}`] = true;
    await runReporterUpdates(s.deps, NOW + 600_000, () => NOW + 600_000);
    assert.equal(s.linear.posts.length, 1);
    assert.equal(s.linear.posts[0]?.body, FIXED);
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
      ticket({
        closingComments: [
          {
            author: "staff",
            body: "Removed the number.",
            createdAt: "2026-10-12T10:00:00Z",
          },
        ],
        identifier: "ENG-4",
        stateType: "completed",
      }),
    ];
    const s = setup(tickets);
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(s.linear.posts.length, 4);
    for (const post of s.linear.posts) {
      assert.ok(wordCount(post.body) <= MAX_UPDATE_WORDS, post.body);
      assert.deepEqual(bannedWordsIn(post.body), [], post.body);
    }
  });
});
