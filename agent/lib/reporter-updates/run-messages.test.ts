import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { OpsFields } from "../ops-log.js";
import {
  DUPLICATE_TEXT,
  FIXED_FALLBACK,
  fixedText,
  LIVE_FALLBACK,
  liveText,
  notFixedText,
  RECEIVED_FALLBACK,
} from "./copy.js";
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
import { NO_REPLY, type WriterReply, type WriterTask } from "./writer.js";

const PR_7638: { body: string; title: string } = JSON.parse(
  readFileSync(new URL("./fixtures/pr-7638.json", import.meta.url), "utf8")
);
const LIVE_PHRASE = "you can now send an email without leaving the power dialler";
const LIVE_STEPS =
  "After a call, click Email in the wrap-up panel, next to Task, Text and Book meeting";
const LIVE_DEPLOY = {
  ancestors: { [`${MERGE_SHA}>${NEW_SHA}`]: true },
  liveSha: NEW_SHA,
  pulls: {
    [pullKey(7)]: merged({ body: PR_7638.body, title: PR_7638.title }),
  },
};

const withWriter = (
  s: ReturnType<typeof setup>,
  replies: Partial<Record<WriterTask["kind"], WriterReply>>
) => {
  const writer = fakeWriter(replies);
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

describe("live message for a feature", () => {
  it("says what the customer can now do and how to use it, from the merged description", async () => {
    const s = setup(
      [
        ticket({
          labels: ["Feature Request"],
          pullUrls: [PR_URL],
          stateType: "completed",
        }),
      ],
      LIVE_DEPLOY
    );
    const writer = withWriter(s, {
      live: { steps: LIVE_STEPS, what: LIVE_PHRASE },
    });
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.equal(
      s.linear.posts[0]?.body,
      "This is live: you can now send an email without leaving the power dialler. After a call, click Email in the wrap-up panel, next to Task, Text and Book meeting."
    );
    const [task] = writer.tasks;
    assert.equal(task?.kind, "live");
    const pull = task && "pull" in task ? task.pull : "";
    assert.ok(pull.includes("Add Email to the existing next-step controls"));
    assert.ok(pull.includes("Power Dialer wrap-up and completed-call dock"));
    assert.ok(!pull.includes("Verification"));
  });

  it("treats a merged pull request titled feat as a feature when the ticket has neither label", async () => {
    const s = setup(
      [ticket({ pullUrls: [PR_URL], stateType: "completed" })],
      LIVE_DEPLOY
    );
    const writer = withWriter(s, {
      live: { steps: LIVE_STEPS, what: LIVE_PHRASE },
    });
    await reconcile(s);
    assert.equal(writer.tasks[0]?.kind, "live");
  });

  it("posts the live fallback when the steps are missing or the model fails", async () => {
    for (const reply of [{ steps: null, what: LIVE_PHRASE }, NO_REPLY]) {
      const s = setup(
        [
          ticket({
            labels: ["Feature Request"],
            pullUrls: [PR_URL],
            stateType: "completed",
          }),
        ],
        LIVE_DEPLOY
      );
      withWriter(s, { live: reply });
      await reconcile(s);
      assert.equal(s.linear.posts[0]?.body, LIVE_FALLBACK);
    }
  });
});

describe("fixed message for a bug", () => {
  it("says what is fixed for a Bug, even when the pull request title starts with feat", async () => {
    const s = setup(
      [
        ticket({
          labels: ["Bug"],
          pullUrls: [PR_URL],
          stateType: "completed",
        }),
      ],
      LIVE_DEPLOY
    );
    const writer = withWriter(s, {
      fixed: {
        steps: null,
        what: "the Resume session card no longer blocks your search bar",
      },
    });
    await reconcile(s);
    assert.equal(writer.tasks[0]?.kind, "fixed");
    assert.equal(
      s.linear.posts[0]?.body,
      "Fixed: the Resume session card no longer blocks your search bar. Give it a go, and reply here if it's still not right."
    );
  });

  it("falls back on a model failure, a banned word or an over-long phrase", async () => {
    const replies: WriterReply[] = [
      NO_REPLY,
      { steps: null, what: "the deploy fixed your export" },
      {
        steps: null,
        what: "the export that used to stop at five hundred rows now includes every single row again",
      },
    ];
    for (const reply of replies) {
      const s = setup(
        [ticket({ labels: ["Bug"], pullUrls: [PR_URL], stateType: "completed" })],
        LIVE_DEPLOY
      );
      withWriter(s, { fixed: reply });
      await reconcile(s);
      assert.equal(s.linear.posts[0]?.body, FIXED_FALLBACK, reply.what ?? "");
    }
  });

  it("keeps the steps only while the whole message stays within the word limit", () => {
    const what = "the Resume session card no longer blocks your search bar";
    const steps =
      "In your second tab, click Not in this tab on the card to hide it. Your dialling keeps running.";
    assert.equal(
      fixedText(what, steps),
      `Fixed: ${what}. ${steps} Reply here if it's still not right.`
    );
    assert.equal(
      fixedText(what, `${steps} ${steps}`),
      `Fixed: ${what}. Give it a go, and reply here if it's still not right.`
    );
  });
});

describe("received fallback", () => {
  it("posts the plain received line when the model fails", async () => {
    const s = setup();
    withWriter(s, { received: NO_REPLY });
    await reconcile(s);
    assert.equal(s.linear.posts[0]?.body, RECEIVED_FALLBACK);
  });
});

describe("done without a pull request", () => {
  const closing = (body: string) => ({
    body,
    createdAt: "2026-10-12T10:00:00Z",
  });

  it("posts Done only when a person's closing comment describes a change", async () => {
    const s = setup([
      ticket({
        closingComments: [closing("Removed the wrong number from the CRM.")],
        stateType: "completed",
      }),
    ]);
    const writer = withWriter(s, {
      done: { steps: null, what: "that number's been removed from the CRM" },
    });
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.equal(
      s.linear.posts[0]?.body,
      "Done: that number's been removed from the CRM. Reply here if anything still looks off."
    );
    const [task] = writer.tasks;
    assert.deepEqual(task && "comments" in task ? task.comments : [], [
      "Removed the wrong number from the CRM.",
    ]);
  });

  it("posts nothing and logs why when no comment describes a change, or the model fails", async () => {
    const cases: [string, ReturnType<typeof ticket>, WriterReply][] = [
      ["no comments", ticket({ stateType: "completed" }), NO_REPLY],
      [
        "comments with no change",
        ticket({
          closingComments: [closing("Could not reproduce.")],
          stateType: "completed",
        }),
        NO_REPLY,
      ],
    ];
    for (const [name, t, reply] of cases) {
      const s = setup([t]);
      const events = logged(s);
      withWriter(s, { done: reply });
      assert.deepEqual(
        await reconcile(s),
        { kind: "skipped", why: "no_evidence_of_change" },
        name
      );
      assert.equal(s.linear.posts.length, 0, name);
      assert.deepEqual(
        events,
        [
          {
            event: "reporter.update_skipped",
            fields: {
              code: "no_evidence_of_change",
              issue: "ENG-1",
              outcome: "skipped",
            },
          },
        ],
        name
      );
    }
  });
});

describe("not a bug and closed reasons", () => {
  it("adds a short reason from the closing comments, and leaves it out when there is none", async () => {
    const t = ticket({
      closingComments: [
        { body: "Exports only cover 12 months.", createdAt: "2026-10-12T10:00:00Z" },
      ],
      labels: ["User Error"],
      stateName: "Canceled",
      stateType: "canceled",
    });
    const s = setup([t]);
    withWriter(s, {
      reason: { steps: null, what: "exports only include the last 12 months" },
    });
    await reconcile(s);
    assert.equal(
      s.linear.posts[0]?.body,
      notFixedText("not_a_bug", "exports only include the last 12 months")
    );
    const bare = setup([
      ticket({ stateName: "Canceled", stateType: "canceled" }),
    ]);
    const writer = withWriter(bare, {});
    await reconcile(bare);
    assert.equal(bare.linear.posts[0]?.body, notFixedText("closed"));
    assert.equal(writer.tasks.length, 0);
  });
});

describe("duplicate follow-up", () => {
  const duplicate = () =>
    ticket({
      duplicateOf: "ENG-9",
      identifier: "ENG-1",
      stateName: "Duplicate",
      stateType: "canceled",
    });

  it("posts the duplicate line, then the fixed message once the original's fix is live", async () => {
    const original = ticket({
      identifier: "ENG-9",
      labels: ["Bug"],
      pullUrls: [PR_URL],
      stateType: "completed",
    });
    const s = setup([duplicate(), original], LIVE_DEPLOY);
    assert.deepEqual(await reconcile(s), {
      kind: "posted",
      stage: "not_fixed",
      waiting: true,
    });
    assert.equal(s.linear.posts[0]?.body, DUPLICATE_TEXT);
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: null, issue: "ENG-1" },
    ]);
    assert.deepEqual(await reconcile(s), { kind: "posted", stage: "fixed" });
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT, fixedText("the export now includes every row", null)]
    );
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
  });

  it("waits while the original is open, and follows up on a later run once it ships", async () => {
    const original = ticket({ identifier: "ENG-9", labels: ["Feature Request"] });
    original.anchorId = null;
    const dup = duplicate();
    dup.updatedAt = "2026-10-11T10:00:00.000Z";
    const s = setup([dup, original], { liveSha: OLD_SHA, pulls: {} });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT]
    );
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.deepEqual(waitingIssues(s.memory), [
      { checkedSha: OLD_SHA, issue: "ENG-1" },
    ]);
    Object.assign(original.facts, {
      pullUrls: [PR_URL],
      stateName: "Done",
      stateType: "completed",
    });
    Object.assign(s.probe.state, {
      ancestors: LIVE_DEPLOY.ancestors,
      liveSha: NEW_SHA,
      pulls: LIVE_DEPLOY.pulls,
    });
    withWriter(s, { live: { steps: LIVE_STEPS, what: LIVE_PHRASE } });
    await runReporterUpdates(s.deps, NOW, () => NOW);
    assert.deepEqual(
      s.linear.posts.map((p) => p.body),
      [DUPLICATE_TEXT, liveText(LIVE_PHRASE, `${LIVE_STEPS}.`)]
    );
    assert.deepEqual(waitingIssues(s.memory), []);
  });

  it("stops waiting when the original is closed without a change", async () => {
    const original = ticket({
      identifier: "ENG-9",
      stateName: "Canceled",
      stateType: "canceled",
    });
    const s = setup([duplicate(), original]);
    await reconcile(s);
    assert.deepEqual(await reconcile(s), {
      kind: "skipped",
      why: "nothing_due",
    });
    assert.equal(s.linear.posts.length, 1);
  });
});
