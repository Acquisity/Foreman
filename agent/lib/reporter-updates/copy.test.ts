import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planReply, type ThreadComment } from "../requester-reply.js";
import {
  bannedWordsIn,
  coversOf,
  firstName,
  fixedText,
  isReporterUpdate,
  MAX_UPDATE_WORDS,
  type NotFixedReason,
  notFixedText,
  ownerText,
  receivedText,
  STAGES,
  stageOfBody,
  withoutReporterUpdates,
  wordCount,
} from "./copy.js";

const REASONS: NotFixedReason[] = ["duplicate", "not_a_bug", "no_change"];

const allTexts = () => [
  receivedText(null),
  receivedText("Sam"),
  ownerText("Sam"),
  fixedText(),
  ...REASONS.map(notFixedText),
];

describe("reporter update wording", () => {
  it("keeps every message at or under 50 words, with a median under 50", () => {
    const counts = allTexts().map(wordCount);
    for (const count of counts) {
      assert.ok(count <= MAX_UPDATE_WORDS, `${count} words`);
    }
    const sorted = [...counts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    assert.ok(median < MAX_UPDATE_WORDS);
  });

  it("uses none of the words a reporter should not see", () => {
    for (const text of allTexts()) {
      assert.deepEqual(bannedWordsIn(text), [], text);
    }
  });

  it("detects the banned words it is meant to catch", () => {
    assert.deepEqual(bannedWordsIn("The deploy of PR 12 failed in CI"), [
      "deploy",
      "PR",
      "CI",
    ]);
    assert.ok(bannedWordsIn("See ENG-123").includes("issue id"));
    assert.ok(bannedWordsIn("The root cause is in agent/lib/x.ts").length >= 2);
    assert.ok(bannedWordsIn("It returned HTTP 500").includes("error code"));
  });

  it("recognises each message as exactly its own stage", () => {
    const byStage = {
      fixed: fixedText(),
      not_fixed: notFixedText("duplicate"),
      owner: ownerText("Sam"),
      received: receivedText("Sam"),
    };
    for (const stage of STAGES) {
      assert.equal(stageOfBody(byStage[stage]), stage);
    }
    assert.equal(stageOfBody(receivedText(null)), "received");
    for (const reason of REASONS) {
      assert.equal(stageOfBody(notFixedText(reason)), "not_fixed");
    }
  });

  it("does not take an ordinary reply for an update", () => {
    assert.equal(
      isReporterUpdate("Here is what we found: the setting is off."),
      false
    );
    assert.equal(isReporterUpdate("Thanks, we've received your report"), false);
  });

  it("names the owner by first name only", () => {
    assert.equal(firstName("Sam Jones"), "Sam");
    assert.equal(firstName("  Ana-Maria Lopez "), "Ana-Maria");
    assert.equal(firstName(null), null);
    assert.equal(firstName(""), null);
    assert.equal(firstName("<@U123> Sam"), null);
  });

  it("says the owner's name in the received message when there is one", () => {
    assert.ok(receivedText("Sam").includes("Sam is looking after it"));
    assert.ok(receivedText(null).includes("our team is looking into it"));
  });
});

describe("reporter updates and the requester thread", () => {
  const FOREMAN = "foreman";
  const anchor: ThreadComment = {
    body: "Slack thread connected in [#sandbox](https://example.slack.com/archives/C0AAAAAAAAA/p1)",
    createdAt: "2026-10-01T10:00:00Z",
    id: "anchor",
    parentId: null,
    userId: "bot",
  };
  const comment = (
    id: string,
    userId: string,
    body: string,
    createdAt: string
  ): ThreadComment => ({ body, createdAt, id, parentId: "anchor", userId });

  it("drops only Foreman's own update comments", () => {
    const comments = [
      comment("a", FOREMAN, receivedText(null), "2026-10-01T10:01:00Z"),
      comment("b", FOREMAN, "A real answer.", "2026-10-01T10:02:00Z"),
      comment("c", "someone", receivedText(null), "2026-10-01T10:03:00Z"),
    ];
    assert.deepEqual(
      withoutReporterUpdates(comments, FOREMAN).map((c) => c.id),
      ["b", "c"]
    );
  });

  it("lets Foreman answer after a received message, which planReply refuses unfiltered", () => {
    const thread = [
      anchor,
      comment("a", FOREMAN, receivedText(null), "2026-10-01T10:01:00Z"),
    ];
    assert.equal(planReply(thread, FOREMAN).ok, false);
    const plan = planReply(withoutReporterUpdates(thread, FOREMAN), FOREMAN);
    assert.deepEqual(plan, { anchorId: "anchor", followUp: null, ok: true });
  });

  it("does not let a later update hide the reporter's own reply from the follow-up check", () => {
    const thread = [
      anchor,
      comment("a", FOREMAN, "Our answer.", "2026-10-01T10:01:00Z"),
      comment("b", "reporter", "It still fails.", "2026-10-01T10:05:00Z"),
      comment("c", FOREMAN, ownerText("Sam"), "2026-10-01T10:06:00Z"),
    ];
    const plan = planReply(withoutReporterUpdates(thread, FOREMAN), FOREMAN);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.ok && plan.followUp, {
      lastReply: "Our answer.",
      replies: ["It still fails."],
    });
  });
});

describe("coversOf", () => {
  it("says a received message that names the owner covers both stages", () => {
    assert.deepEqual(coversOf(receivedText("Sam")), ["received", "owner"]);
    assert.deepEqual(coversOf(receivedText(null)), ["received"]);
    assert.deepEqual(coversOf(ownerText("Sam")), ["owner"]);
    assert.deepEqual(coversOf(fixedText()), ["fixed"]);
    assert.deepEqual(coversOf(notFixedText("duplicate")), ["not_fixed"]);
    assert.deepEqual(coversOf("An ordinary reply."), []);
  });
});
