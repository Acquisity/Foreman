import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OpsFields } from "../ops-log.js";
import { commentIdFor } from "./comment-id.js";
import { notFixedText, type VerdictOutcome, verdictText } from "./copy.js";
import {
  type FakeTicket,
  fakeWriter,
  NOW,
  RECEIVED,
  reconcile,
  setup,
  ticket,
} from "./fakes.js";
import type { TicketFacts } from "./plan.js";
import { runReporterUpdates } from "./run.js";
import { NO_REPLY, type WriterReply } from "./writer.js";

const SAN_145 = readFileSync(
  new URL("./fixtures/san-145-fixy-reply.md", import.meta.url),
  "utf8"
);
const TEST_REPLY = "OK. This is a test.";
const VERDICT_ID = commentIdFor("ENG-1", "verdict");
const FIX_IN_REVIEW = verdictText("fix_in_review");

const reply = (body: string): TicketFacts["fixyVerdict"] => ({
  body,
  createdAt: "2026-10-12T10:00:00.000Z",
});

/** An open Bug ticket whose Fixy run finished. */
const verdictTicket = (over: Partial<TicketFacts> = {}): FakeTicket =>
  ticket({
    fixyHandoffUpdatedAt: "2026-10-11T10:00:00.000Z",
    fixyVerdict: reply(SAN_145),
    labels: ["Bug", "factory:pr-open"],
    stateName: "In Review",
    stateType: "started",
    teamKey: "SAN",
    ...over,
  });

/** The schedule for one ticket, with received already sent unless told otherwise. */
const setupWith = async (t: FakeTicket, received = true) => {
  const s = setup([t]);
  if (received) {
    await s.memory.store.markSent(
      "ENG-1",
      ["received"],
      RECEIVED,
      null,
      commentIdFor("ENG-1", "received")
    );
  }
  return s;
};

const answering = (s: ReturnType<typeof setup>, verdict: WriterReply) => {
  const writer = fakeWriter({ verdict });
  s.deps.write = writer.write;
  return writer;
};

const logged = (s: ReturnType<typeof setup>) => {
  const events: { event: string; fields: OpsFields }[] = [];
  s.deps.log = (event, fields) => {
    events.push({ event, fields });
  };
  return events;
};

const verdictOf = (
  verdict: VerdictOutcome | null,
  what: string | null = null
) => ({
  steps: null,
  verdict,
  what,
});

const previousTeams = process.env.FIXY_TRIAGE_TEAMS;
beforeEach(() => {
  process.env.FIXY_TRIAGE_TEAMS = "SAN";
});
afterEach(() => {
  if (previousTeams === undefined) {
    Reflect.deleteProperty(process.env, "FIXY_TRIAGE_TEAMS");
  } else {
    process.env.FIXY_TRIAGE_TEAMS = previousTeams;
  }
});

describe("Fixy's verdict for the reporter", () => {
  for (const [name, teams, over] of [
    ["empty setting", "", {}],
    ["off-list current team", "SAN", { teamKey: "ENG" }],
    ["missing handoff", "SAN", { fixyHandoffUpdatedAt: null }],
    [
      "reply older than the latest handoff edit",
      "SAN",
      { fixyHandoffUpdatedAt: "2026-10-13T10:00:00.000Z" },
    ],
  ] as const) {
    it(`does not plan a verdict with ${name}`, async () => {
      process.env.FIXY_TRIAGE_TEAMS = teams;
      const s = await setupWith(verdictTicket(over));
      assert.deepEqual(await reconcile(s), {
        kind: "skipped",
        why: "nothing_due",
      });
      assert.equal(s.linear.posts.length, 0);
      assert.equal(s.writer.tasks.length, 0);
    });
  }

  it("rechecks the current team setting for a queued ticket after it is disabled", async () => {
    const t = verdictTicket();
    t.updatedAt = new Date(NOW - 3_600_000).toISOString();
    const s = await setupWith(t);
    await s.memory.store.saveCursor(NOW);
    await s.memory.store.enqueue([
      { issue: "ENG-1", version: Date.parse(t.updatedAt) },
    ]);
    process.env.FIXY_TRIAGE_TEAMS = "";
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(s.linear.posts.length, 0);
    assert.equal(s.writer.tasks.length, 0);
  });

  it("keeps a due verdict pending after a delayed received with unchanged updatedAt", async () => {
    const t = verdictTicket();
    t.updatedAt = new Date(NOW - 3_600_000).toISOString();
    const s = await setupWith(t, false);
    s.memory.state.now = NOW;
    await s.memory.store.saveCursor(NOW);
    await s.memory.store.enqueue([
      { issue: "ENG-1", version: Date.parse(t.updatedAt) },
    ]);
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.equal(s.linear.posts[0]?.id, commentIdFor("ENG-1", "received"));
    assert.equal(s.memory.pending.has("ENG-1"), true);
    assert.equal(t.updatedAt, new Date(NOW - 3_600_000).toISOString());
    s.memory.state.now += 60_000;
    await runReporterUpdates(s.deps, NOW + 60_000, () => NOW + 60_000);
    assert.equal(s.linear.posts[1]?.id, VERDICT_ID);
    assert.equal(s.memory.pending.has("ENG-1"), false);
  });

  it("posts one verdict update for SAN-145's reply under the Slack anchor, and never a second", async () => {
    const s = await setupWith(verdictTicket());
    const writer = answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "verdict" });
    assert.deepEqual(
      s.linear.posts.map((post) => [post.id, post.body]),
      [[VERDICT_ID, FIX_IN_REVIEW]]
    );
    assert.deepEqual(await s.linear.port.findComment(VERDICT_ID), {
      parentId: "anchor-1",
    });
    const [task] = writer.tasks;
    assert.equal(task?.kind, "verdict");
    assert.ok(
      task && "reply" in task && task.reply.startsWith("I fixed and proved")
    );
    assert.equal(s.memory.table.get("ENG-1|verdict")?.status, "sent");
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
    assert.equal(writer.tasks.length, 1);
  });

  it("posts nothing while Fixy's run is still going", async () => {
    const s = await setupWith(
      verdictTicket({ labels: ["Bug", "factory:running"] })
    );
    const writer = answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 0);
    assert.equal(writer.tasks.length, 0);
  });

  it("posts nothing on a ticket without the Bug label", async () => {
    const s = await setupWith(verdictTicket({ labels: ["factory:pr-open"] }));
    const writer = answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 0);
    assert.equal(writer.tasks.length, 0);
  });

  it("posts nothing when Fixy has not replied", async () => {
    const s = await setupWith(verdictTicket({ fixyVerdict: null }));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 0);
  });

  it("posts received first and the verdict on a later run", async () => {
    const s = await setupWith(verdictTicket(), false);
    answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      pendingVerdict: true,
      stage: "received",
    });
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "verdict" });
    assert.deepEqual(
      s.linear.posts.map((post) => post.id),
      [commentIdFor("ENG-1", "received"), VERDICT_ID]
    );
    assert.equal(s.linear.posts[0]?.body, RECEIVED);
  });

  it("posts nothing for a test reply judged none, logs why, records no stage, and still posts a later real reply", async () => {
    const t = verdictTicket({ fixyVerdict: reply(TEST_REPLY) });
    const s = await setupWith(t);
    const events = logged(s);
    answering(s, verdictOf("none"));
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "no_reporter_verdict",
    });
    assert.equal(s.linear.posts.length, 0);
    assert.equal(s.memory.table.has("ENG-1|verdict"), false);
    assert.deepEqual(events, [
      {
        event: "reporter.update_skipped",
        fields: {
          code: "no_reporter_verdict",
          issue: "ENG-1",
          outcome: "skipped",
        },
      },
    ]);
    t.facts.fixyVerdict = reply(SAN_145);
    answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "verdict" });
    assert.equal(s.linear.posts[0]?.body, FIX_IN_REVIEW);
  });

  for (const [name, answer] of [
    ["fails", NO_REPLY],
    [
      "returns an outcome it does not know",
      verdictOf("escalate" as VerdictOutcome),
    ],
  ] as const) {
    it(`posts nothing when the writer ${name}`, async () => {
      const s = await setupWith(verdictTicket());
      answering(s, answer);
      assert.deepEqual(await reconcile(s), {
        kind: "skipped",
        why: "no_reporter_verdict",
      });
      assert.equal(s.linear.posts.length, 0);
      assert.equal(s.memory.table.has("ENG-1|verdict"), false);
    });
  }

  it("gives a closed ticket only its close message, never a late verdict", async () => {
    const s = await setupWith(
      verdictTicket({
        labels: ["Bug", "User Error"],
        stateName: "Canceled",
        stateType: "canceled",
      })
    );
    const writer = answering(s, verdictOf("not_a_bug"));
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
    });
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.deepEqual(
      s.linear.posts.map((post) => post.body),
      [notFixedText("not_a_bug")]
    );
    assert.ok(writer.tasks.every((task) => task.kind !== "verdict"));
  });

  it("keeps a plain not-a-bug reason and drops one with a banned word, never the message", async () => {
    const kept = await setupWith(verdictTicket());
    answering(
      kept,
      verdictOf("not_a_bug", "exports only include the last 12 months")
    );
    await reconcile(kept);
    assert.equal(
      kept.linear.posts[0]?.body,
      verdictText("not_a_bug", "exports only include the last 12 months")
    );
    assert.ok(
      kept.linear.posts[0]?.body.includes(
        ": exports only include the last 12 months."
      )
    );
    const dropped = await setupWith(verdictTicket());
    answering(dropped, verdictOf("not_a_bug", "the ticket was a duplicate"));
    await reconcile(dropped);
    assert.equal(dropped.linear.posts[0]?.body, verdictText("not_a_bug"));
  });

  it("recognises a verdict already in the thread by its id and records it instead of posting", async () => {
    const t = verdictTicket();
    t.foremanComments.push({
      body: "Anything the model wrote.",
      id: VERDICT_ID,
    });
    const s = await setupWith(t);
    const writer = answering(s, verdictOf("fix_in_review"));
    assert.deepEqual(await reconcile(s), {
      kind: "recorded",
      stage: "verdict",
    });
    assert.equal(s.memory.table.get("ENG-1|verdict")?.commentId, VERDICT_ID);
    assert.equal(s.linear.posts.length, 0);
    assert.equal(writer.tasks.length, 0);
  });
});
