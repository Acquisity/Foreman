import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadIncompleteError } from "../requester-reply.js";
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
  setup,
  ticket,
  waitingIssues,
} from "./fakes.js";
import { runReporterUpdates } from "./run.js";

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
      retryAfter: 0,
      stage: "received",
      status: "sent",
      token: null,
      updatedAt: 0,
    });
    await run(s);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [FIXED]
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
    await s.memory.store.enqueue([{ issue: "ENG-1", version: 1 }]);
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
    assert.ok(report.errors[0]?.startsWith("ENG-1: ENG-1 has more than 1,000"));
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

  it("keeps the backoff when the overlap lists an unchanged ticket again, and clears it only when the ticket has moved on", async () => {
    const t = old(1, { stateName: "Duplicate", stateType: "canceled" });
    t.updatedAt = new Date(NOW - 60_000).toISOString();
    const s = setup([t]);
    s.linear.state.failNextPost = true;
    await run(s);
    s.memory.state.now += 60_000;
    const second = await run(s, NOW + 300_000);
    assert.equal(second.errors.length, 0);
    assert.equal(s.linear.state.discoveries[1]?.after, null);
    assert.equal(s.linear.posts.length, 0, "no early retry");
    assert.equal(s.memory.pending.get("ENG-1")?.attempts, 1, "attempts kept");
    t.updatedAt = new Date(NOW + 400_000).toISOString();
    await run(s, NOW + 600_000);
    assert.equal(s.linear.posts.length, 1, "a real change retries at once");
  });

  it("treats a change to the master as the ticket having moved on", async () => {
    const t = old(1, { stateName: "Duplicate", stateType: "canceled" });
    t.updatedAt = new Date(NOW - 60_000).toISOString();
    t.parentUpdatedAt = new Date(NOW - 50_000).toISOString();
    const s = setup([t]);
    s.linear.state.failNextPost = true;
    await run(s);
    t.parentUpdatedAt = new Date(NOW + 100_000).toISOString();
    await run(s, NOW + 300_000);
    assert.equal(s.linear.posts.length, 1);
  });

  it("makes the first retry after a failed post at the configured five minutes, and the next at ten", async () => {
    const t = old(1, { stateName: "Duplicate", stateType: "canceled" });
    const s = setup([t]);
    const MIN = 60_000;
    s.linear.state.failNextPost = true;
    await run(s);
    s.memory.state.now += 4 * MIN;
    await run(s, NOW + 4 * MIN);
    assert.equal(s.linear.posts.length, 0, "not before five minutes");
    s.linear.state.failNextPost = true;
    s.memory.state.now += 1 * MIN;
    const retry = await run(s, NOW + 5 * MIN);
    assert.equal(retry.errors.length, 1, "tried again at five minutes");
    s.memory.state.now += 9 * MIN;
    await run(s, NOW + 14 * MIN);
    assert.equal(s.linear.posts.length, 0, "not before ten more");
    s.memory.state.now += 1 * MIN;
    await run(s, NOW + 15 * MIN);
    assert.equal(
      s.linear.posts.length,
      1,
      "delivered ten minutes after the second failure"
    );
  });

  it("lines a busy ticket up with the moment its claim lapses, without counting a failure", async () => {
    const s = setup([
      old(1, { stateName: "Duplicate", stateType: "canceled" }),
    ]);
    await s.memory.store.claim("ENG-1", "not_fixed", "x", null);
    await s.memory.store.enqueue([{ issue: "ENG-1", version: 1 }]);
    await run(s);
    assert.equal(s.memory.pending.get("ENG-1")?.attempts, 0);
    assert.equal(s.memory.pending.get("ENG-1")?.retryAfter, 600_000);
    s.memory.state.now = 600_001;
    await run(s, NOW + 600_001);
    assert.equal(s.linear.posts.length, 1);
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

  it("keeps a newer version queued when an older run finishes the ticket after discovery has moved on", async () => {
    const t = old(1);
    const s = setup([t], {
      ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
      liveSha: NEW_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    let release: () => void = () => undefined;
    s.linear.state.holdNextPost = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(s);
    const inFlight = async (tries: number): Promise<void> => {
      if (s.linear.state.holdNextPost && tries > 0) {
        await new Promise((resolve) => setImmediate(resolve));
        await inFlight(tries - 1);
      }
    };
    await inFlight(100);
    assert.equal(
      s.linear.state.holdNextPost,
      null,
      "the received post is in flight"
    );

    Object.assign(t.facts, { pullUrls: [PR_URL], stateType: "completed" });
    t.updatedAt = new Date(NOW + 30_000).toISOString();
    const later = NOW + 15 * 60_000;
    await runReporterUpdates(
      { ...s.deps, config: { ...s.deps.config, runDeadlineMs: 0 } },
      later,
      () => later
    );
    assert.equal(
      s.memory.pending.get("ENG-1")?.version,
      Date.parse(t.updatedAt)
    );

    release();
    await first;
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [RECEIVED]
    );
    assert.equal(
      s.memory.pending.get("ENG-1")?.version,
      Date.parse(t.updatedAt),
      "the older run does not acknowledge the newer version"
    );

    await run(s, NOW + 3_600_000);
    assert.ok(
      Date.parse(s.linear.state.discoveries.at(-1)?.updatedSince ?? "") >
        Date.parse(t.updatedAt),
      "the last sweep is past the overlap, so it cannot rediscover the change"
    );
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [RECEIVED, FIXED]
    );
    assert.equal(s.memory.pending.size, 0);
  });

  it("keeps the deploy wait a newer run recorded when an older run finishes the ticket afterwards", async () => {
    const t = old(1);
    const s = setup([t], {
      ancestors: { [`${MERGE_SHA}>${OLD_SHA}`]: false },
      liveSha: OLD_SHA,
      pulls: { [pullKey(7)]: merged() },
    });
    let release: () => void = () => undefined;
    s.linear.state.holdNextPost = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(s);
    const inFlight = async (tries: number): Promise<void> => {
      if (s.linear.state.holdNextPost && tries > 0) {
        await new Promise((resolve) => setImmediate(resolve));
        await inFlight(tries - 1);
      }
    };
    await inFlight(100);
    assert.equal(
      s.linear.state.holdNextPost,
      null,
      "the received post is in flight"
    );

    Object.assign(t.facts, { pullUrls: [PR_URL], stateType: "completed" });
    t.updatedAt = new Date(NOW + 30_000).toISOString();
    const report = await run(s, NOW + 15 * 60_000);
    assert.deepEqual(
      report.outcomes.map((o) => o.outcome),
      [{ kind: "waiting" }]
    );
    assert.equal(s.memory.pending.size, 0);

    release();
    await first;
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: OLD_SHA, issue: "ENG-1" },
    ]);

    s.probe.state.liveSha = NEW_SHA;
    s.probe.state.ancestors[`${MERGE_SHA}>${NEW_SHA}`] = true;
    await run(s, NOW + 3_600_000);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [RECEIVED, FIXED]
    );
  });
});
