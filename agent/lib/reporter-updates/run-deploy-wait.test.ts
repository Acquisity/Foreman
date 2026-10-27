import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notFixedText } from "./copy.js";
import { githubDeployProbe } from "./deploy.js";
import {
  depsOf,
  FIXED,
  fakeDeploy,
  fakeLinear,
  MERGE_SHA,
  memoryStore,
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
      [FIXED]
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

  it("holds a fix in a repository with no deploy signal, and never calls a Done bug with no linked pull request fixed", async () => {
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
      kind: "skipped",
      why: "no_evidence_of_change",
    });
    assert.equal(other.linear.posts.length + bug.linear.posts.length, 0);
  });
});

describe("a deploy wait that is no longer needed", () => {
  const NEWER_SHA = "4444444444444444444444444444444444444444";
  const MIN = 300_000;
  const abandonCases: [
    string,
    (s: ReturnType<typeof setup>, t: ReturnType<typeof ticket>) => void,
  ][] = [
    [
      "the ticket is cancelled",
      (_s, t) => {
        t.facts.stateName = "Canceled";
        t.facts.stateType = "canceled";
      },
    ],
    [
      "the ticket is reopened",
      (_s, t) => {
        t.facts.stateType = "started";
      },
    ],
    [
      "its fix pull request is closed without merging",
      (s) => {
        s.probe.state.pulls[pullKey(7)] = merged({
          mergeSha: null,
          state: "closed",
        });
      },
    ],
    [
      "the ticket can no longer be found",
      (s) => {
        s.linear.port.readTicket = () => Promise.resolve(null);
      },
    ],
  ];

  for (const [name, abandon] of abandonCases) {
    it(`closes the waiting row and never requeues it when ${name}`, async () => {
      const t = ticket({ pullUrls: [PR_URL], stateType: "completed" });
      const s = setup([t], {
        liveSha: OLD_SHA,
        pulls: { [pullKey(7)]: merged() },
      });
      await runReporterUpdates(s.deps, NOW, () => NOW);
      assert.equal(waitingIssues(s.memory).length, 1);
      abandon(s, t);
      s.probe.state.liveSha = NEW_SHA;
      await runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN);
      assert.deepEqual(waitingIssues(s.memory), []);
      const { reads } = s.linear.state;
      s.probe.state.liveSha = NEWER_SHA;
      await runReporterUpdates(s.deps, NOW + 2 * MIN, () => NOW + 2 * MIN);
      assert.equal(
        s.linear.state.reads,
        reads,
        "not read again after the next deploy"
      );
      assert.equal(s.memory.pending.size, 0);
    });
  }

  it("still finds a ticket that becomes Done again later, and posts once its fix is live", async () => {
    const t = ticket({ pullUrls: [PR_URL], stateType: "completed" });
    const s = setup([t], {
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    t.facts.stateType = "started";
    s.probe.state.liveSha = NEW_SHA;
    await runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN);
    assert.deepEqual(waitingIssues(s.memory), []);
    t.facts.stateType = "completed";
    t.updatedAt = new Date(NOW + 2 * MIN - 1000).toISOString();
    await runReporterUpdates(s.deps, NOW + 2 * MIN, () => NOW + 2 * MIN);
    assert.equal(waitingIssues(s.memory).length, 1);
    s.probe.state.liveSha = NEWER_SHA;
    s.probe.state.ancestors[`${MERGE_SHA}>${NEWER_SHA}`] = true;
    await runReporterUpdates(s.deps, NOW + 3 * MIN, () => NOW + 3 * MIN);
    assert.ok(s.linear.posts.some((p) => p.body === FIXED));
  });

  describe("when the channel is turned off", () => {
    const NOT_SANDBOX = new Set(["C0OTHER00000"]);
    const doneWithFix = () => {
      const t = ticket({ pullUrls: [PR_URL], stateType: "completed" });
      return setup([t], {
        liveSha: OLD_SHA,
        pulls: { [pullKey(7)]: merged() },
      });
    };

    it("keeps the fixed update, and sends exactly one once the channel is back and a deploy holds the fix", async () => {
      const s = doneWithFix();
      await runReporterUpdates(s.deps, NOW, () => NOW);
      s.deps.config.channels = NOT_SANDBOX;
      s.probe.state.liveSha = NEW_SHA;
      await runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN);
      assert.equal(s.linear.posts.length, 0);
      assert.deepEqual(waitingIssues(s.memory), [
        { checkedSha: NEW_SHA, issue: "ENG-1" },
      ]);
      s.deps.config.channels = new Set([SANDBOX]);
      s.probe.state.liveSha = NEWER_SHA;
      s.probe.state.ancestors[`${MERGE_SHA}>${NEWER_SHA}`] = true;
      await runReporterUpdates(s.deps, NOW + 2 * MIN, () => NOW + 2 * MIN);
      await runReporterUpdates(s.deps, NOW + 3 * MIN, () => NOW + 3 * MIN);
      assert.deepEqual(
        s.linear.posts.map((p) => p.body),
        [FIXED]
      );
    });

    it("requeues the row once per deploy, not on every run", async () => {
      const s = doneWithFix();
      await runReporterUpdates(s.deps, NOW, () => NOW);
      s.deps.config.channels = NOT_SANDBOX;
      s.probe.state.liveSha = NEW_SHA;
      await runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN);
      const afterFirstDeploy = s.linear.state.reads;
      await runReporterUpdates(s.deps, NOW + 2 * MIN, () => NOW + 2 * MIN);
      await runReporterUpdates(s.deps, NOW + 3 * MIN, () => NOW + 3 * MIN);
      assert.equal(s.linear.state.reads, afterFirstDeploy);
      s.probe.state.liveSha = NEWER_SHA;
      await runReporterUpdates(s.deps, NOW + 4 * MIN, () => NOW + 4 * MIN);
      assert.equal(s.linear.state.reads, afterFirstDeploy + 1);
      await runReporterUpdates(s.deps, NOW + 5 * MIN, () => NOW + 5 * MIN);
      assert.equal(s.linear.state.reads, afterFirstDeploy + 1);
      assert.equal(waitingIssues(s.memory).length, 1);
    });
  });

  it("retries closing the wait on the next run when the cleanup write fails once", async () => {
    const t = ticket({ pullUrls: [PR_URL], stateType: "completed" });
    t.updatedAt = new Date(NOW - 60_000).toISOString();
    const s = setup([t], {
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(waitingIssues(s.memory).length, 1);
    t.facts.stateName = "Canceled";
    t.facts.stateType = "canceled";
    t.updatedAt = new Date(NOW + 60_000).toISOString();
    s.memory.state.failNextResolve = true;
    await assert.rejects(
      runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN),
      { message: "database unavailable" }
    );
    assert.equal(waitingIssues(s.memory).length, 1);
    assert.equal(s.memory.pending.has("ENG-1"), true, "the retry is kept");
    const moved = NOW + 30 * MIN;
    await runReporterUpdates(
      { ...s.deps, config: { ...s.deps.config, runDeadlineMs: 0 } },
      moved,
      () => moved
    );
    const later = NOW + 60 * MIN;
    await runReporterUpdates(s.deps, later, () => later);
    assert.ok(
      Date.parse(s.linear.state.discoveries.at(-1)?.updatedSince ?? "") >
        Date.parse(t.updatedAt),
      "the retry comes from the kept entry, not from rediscovery"
    );
    assert.deepEqual(waitingIssues(s.memory), []);
    assert.equal(s.memory.pending.size, 0);
    assert.equal(s.linear.posts.length, 1);
  });

  it("keeps the row while the ticket still needs the deploy", async () => {
    const t = ticket({ pullUrls: [PR_URL], stateType: "completed" });
    const s = setup([t], {
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    s.probe.state.liveSha = NEW_SHA;
    await runReporterUpdates(s.deps, NOW + MIN, () => NOW + MIN);
    assert.equal(waitingIssues(s.memory).length, 1);
    assert.equal(waitingIssues(s.memory)[0]?.checkedSha, NEW_SHA);
  });
});

describe("a slow deployment scan", () => {
  it("leaves the received and closed messages delivered in the same run, and makes fixed wait", async () => {
    const waiting = ticket({
      identifier: "ENG-1",
      pullUrls: [PR_URL],
      stateType: "completed",
    });
    const fresh = ticket({ identifier: "ENG-2" });
    const duplicate = ticket({
      identifier: "ENG-3",
      stateName: "Canceled",
      stateType: "canceled",
    });
    const named = ticket({ identifier: "ENG-4" });
    const tickets = [waiting, fresh, duplicate, named];
    for (const t of tickets) {
      t.updatedAt = "2026-10-11T10:00:00.000Z";
    }
    const linear = fakeLinear(tickets);
    const memory = memoryStore();
    memory.table.set("ENG-4|received", {
      attempts: 1,
      checkedSha: null,
      claimedAt: 0,
      commentId: "c",
      message: "",
      retryAfter: 0,
      stage: "received",
      status: "sent",
      token: null,
      updatedAt: 0,
    });
    const fake = fakeDeploy({
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    const slowReads = githubDeployProbe(
      () => Promise.resolve("token"),
      async (input: string | URL | Request) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const url = String(input);
        return url.includes("/statuses")
          ? Response.json([{ creator: { login: "actor" }, state: "success" }])
          : Response.json(
              Array.from({ length: 30 }, (_, i) => ({
                id: 100 - i,
                sha: NEW_SHA,
              }))
            );
      },
      1000,
      120
    );
    const deps = depsOf(
      linear.port,
      { ...fake.probe, liveSha: slowReads.liveSha },
      memory.store,
      {
        runDeadlineMs: 600,
      }
    );
    const started = Date.now();
    const report = await runReporterUpdates(deps, started);
    assert.equal(report.errors.length, 0);
    assert.deepEqual(
      linear.posts
        .map((p) => `${p.identifier} ${p.body}`)
        .sort((a, b) => a.localeCompare(b)),
      [`ENG-2 ${RECEIVED}`, `ENG-3 ${notFixedText("closed")}`].sort((a, b) =>
        a.localeCompare(b)
      )
    );
    assert.equal(
      waitingIssues(memory).length,
      1,
      "fixed waits for a known live commit"
    );
    assert.ok(Date.now() - started < 600);
  });
});
