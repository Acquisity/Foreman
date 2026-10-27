import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planReply, type ThreadComment } from "../requester-reply.js";
import { commentIdFor } from "./comment-id.js";
import {
  bannedWordsIn,
  cleanPhrase,
  cleanSteps,
  coversOf,
  DUPLICATE_TEXT,
  doneText,
  FIXED_FALLBACK,
  firstName,
  fixedText,
  isReporterUpdate,
  LIVE_FALLBACK,
  liveText,
  MAX_UPDATE_WORDS,
  type NotFixedReason,
  notFixedText,
  PAST_TEXTS,
  RECEIVED_FALLBACK,
  receivedText,
  STAGES,
  stageOfCommentId,
  withoutReporterUpdates,
  wordCount,
} from "./copy.js";

const REASONS: NotFixedReason[] = ["duplicate", "not_a_bug", "closed"];
const WHAT = "why your email threads won't load";
const STEPS =
  "After a call, click Email in the wrap-up panel, next to Task, Text and Book meeting.";

const allTexts = () => [
  receivedText(null),
  receivedText(WHAT),
  fixedText(null, null),
  fixedText("the Resume session card no longer blocks your search bar", null),
  liveText(null, null),
  liveText("you can now send an email without leaving the power dialler", STEPS),
  doneText("that number's been removed from the CRM") ?? "",
  ...REASONS.map((reason) => notFixedText(reason)),
  ...REASONS.map((reason) => notFixedText(reason, "exports only cover a year")),
];

describe("reporter update wording", () => {
  it("keeps every message at or under 40 words", () => {
    for (const text of allTexts()) {
      assert.ok(wordCount(text) <= MAX_UPDATE_WORDS, `${text}`);
    }
  });

  it("uses none of the words a reporter should not see, and no filler", () => {
    for (const text of allTexts()) {
      assert.deepEqual(bannedWordsIn(text), [], text);
    }
  });

  it("detects the banned words and filler it is meant to catch", () => {
    assert.deepEqual(bannedWordsIn("The deploy of PR 12 failed in CI"), [
      "deploy",
      "PR",
      "CI",
    ]);
    assert.ok(bannedWordsIn("See ENG-123").includes("issue id"));
    assert.ok(bannedWordsIn("The root cause is in agent/lib/x.ts").length >= 2);
    assert.ok(bannedWordsIn("It returned HTTP 500").includes("error code"));
    assert.ok(bannedWordsIn("Our developer fixed it").includes("developer"));
    assert.ok(bannedWordsIn("Good news: it works").includes("filler"));
    assert.ok(
      bannedWordsIn("Nothing for you to do right now.").includes("filler")
    );
  });

  it("writes the received message with the phrase and never an owner", () => {
    assert.equal(
      receivedText(WHAT),
      "Thanks, got it. We're looking into why your email threads won't load and will reply here when we know more."
    );
    assert.equal(receivedText(null), RECEIVED_FALLBACK);
    assert.ok(!receivedText(null).includes("looking after"));
  });

  it("writes fixed, live and done messages from the spec", () => {
    assert.equal(
      fixedText("the Resume session card no longer blocks your search bar", null),
      "Fixed: the Resume session card no longer blocks your search bar. Give it a go, and reply here if it's still not right."
    );
    assert.equal(fixedText(null, null), FIXED_FALLBACK);
    assert.equal(
      liveText("you can now send an email without leaving the power dialler", STEPS),
      `This is live: you can now send an email without leaving the power dialler. ${STEPS}`
    );
    assert.equal(liveText("you can now do X", null), LIVE_FALLBACK);
    assert.equal(liveText(null, STEPS), LIVE_FALLBACK);
    assert.equal(
      doneText("that number's been removed from the CRM"),
      "Done: that number's been removed from the CRM. Reply here if anything still looks off."
    );
    assert.equal(doneText(null), null);
  });

  it("writes not-a-bug and closed with an optional reason, and the duplicate line", () => {
    assert.equal(
      notFixedText("not_a_bug"),
      "We checked, and this is working the way it's meant to right now. If that's not what you saw, reply here with a screenshot and we'll take another look."
    );
    assert.equal(
      notFixedText("closed", "exports only cover a year"),
      "We've looked into this and won't be changing anything for now: exports only cover a year. Reply here if it's still causing you trouble."
    );
    assert.equal(notFixedText("duplicate", "anything"), DUPLICATE_TEXT);
  });

  it("falls back when a whole message would run over the word limit", () => {
    const long = Array.from({ length: 15 }, () => "word").join(" ");
    const steps = `${Array.from({ length: 25 }, () => "step").join(" ")}.`;
    assert.equal(liveText(long, steps), LIVE_FALLBACK);
  });
});

describe("cleanPhrase and cleanSteps", () => {
  it("accepts a short plain phrase and drops its closing stop", () => {
    assert.equal(cleanPhrase(" why your threads won't load. ", 15), "why your threads won't load");
    assert.equal(cleanSteps("Click Email in the wrap-up panel", 25), "Click Email in the wrap-up panel.");
  });

  it("refuses an empty, over-long, marked-up, banned or owner-naming phrase", () => {
    assert.equal(cleanPhrase("", 15), null);
    assert.equal(cleanPhrase(null, 15), null);
    assert.equal(
      cleanPhrase(Array.from({ length: 16 }, () => "word").join(" "), 15),
      null
    );
    assert.equal(cleanPhrase("the fix in `dialer.tsx`", 15), null);
    assert.equal(cleanPhrase("see https://example.com", 15), null);
    assert.equal(cleanPhrase("the deploy went out", 15), null);
    assert.equal(cleanPhrase("Sam fixed the export", 15, "Sam"), null);
    assert.equal(cleanPhrase("the sample export", 15, "Sam"), "the sample export");
  });
});

describe("recognising messages already in the thread", () => {
  it("still recognises every exact text the first version posted", () => {
    assert.deepEqual(coversOf(PAST_TEXTS.received[0] ?? ""), ["received"]);
    assert.deepEqual(
      coversOf(
        "We've received your report and Sam is looking after it. Nothing for you to do right now. We'll write here again as soon as there's news."
      ),
      ["received", "owner"]
    );
    assert.deepEqual(
      coversOf(
        "Sam is now looking after your report. Nothing for you to do. We'll write here again as soon as there's news."
      ),
      ["owner"]
    );
    assert.deepEqual(coversOf(PAST_TEXTS.fixed[0] ?? ""), ["fixed"]);
    for (const text of PAST_TEXTS.not_fixed) {
      assert.deepEqual(coversOf(text), ["not_fixed"], text);
    }
    assert.deepEqual(coversOf("An ordinary reply."), []);
  });

  it("recognises a v2 message by its comment id, whatever the model wrote", () => {
    for (const stage of STAGES) {
      assert.equal(stageOfCommentId("ENG-1", commentIdFor("ENG-1", stage)), stage);
      assert.equal(stageOfCommentId("ENG-2", commentIdFor("ENG-1", stage)), null);
    }
    assert.equal(stageOfCommentId("ENG-1", commentIdFor("ENG-1", "owner")), "owner");
    assert.equal(
      isReporterUpdate("ENG-1", {
        body: "Fixed: anything at all.",
        id: commentIdFor("ENG-1", "fixed"),
      }),
      true
    );
    assert.equal(
      isReporterUpdate("ENG-1", { body: "Here is what we found.", id: "x" }),
      false
    );
  });

  it("does not take a v2 text with an unknown id for an update", () => {
    assert.equal(
      isReporterUpdate("ENG-1", { body: receivedText(WHAT), id: "other" }),
      false
    );
  });

  it("names the owner by first name only, for the leak check", () => {
    assert.equal(firstName("Sam Jones"), "Sam");
    assert.equal(firstName("  Ana-Maria Lopez "), "Ana-Maria");
    assert.equal(firstName(null), null);
    assert.equal(firstName("<@U123> Sam"), null);
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
  const receivedId = commentIdFor("ENG-1", "received");

  it("drops only Foreman's own update comments, v1 by text and v2 by id", () => {
    const comments = [
      comment(receivedId, FOREMAN, receivedText(WHAT), "2026-10-01T10:01:00Z"),
      comment("b", FOREMAN, "A real answer.", "2026-10-01T10:02:00Z"),
      comment("c", "someone", receivedText(null), "2026-10-01T10:03:00Z"),
      comment("d", FOREMAN, PAST_TEXTS.received[0] ?? "", "2026-10-01T10:04:00Z"),
    ];
    assert.deepEqual(
      withoutReporterUpdates(comments, FOREMAN, "ENG-1").map((c) => c.id),
      ["b", "c"]
    );
  });

  it("lets Foreman answer after a received message, which planReply refuses unfiltered", () => {
    const thread = [
      anchor,
      comment(receivedId, FOREMAN, receivedText(WHAT), "2026-10-01T10:01:00Z"),
    ];
    assert.equal(planReply(thread, FOREMAN).ok, false);
    const plan = planReply(
      withoutReporterUpdates(thread, FOREMAN, "ENG-1"),
      FOREMAN
    );
    assert.deepEqual(plan, { anchorId: "anchor", followUp: null, ok: true });
  });

  it("does not let a later update hide the reporter's own reply from the follow-up check", () => {
    const thread = [
      anchor,
      comment("a", FOREMAN, "Our answer.", "2026-10-01T10:01:00Z"),
      comment("b", "reporter", "It still fails.", "2026-10-01T10:05:00Z"),
      comment(
        commentIdFor("ENG-1", "fixed"),
        FOREMAN,
        fixedText(null, null),
        "2026-10-01T10:06:00Z"
      ),
    ];
    const plan = planReply(
      withoutReporterUpdates(thread, FOREMAN, "ENG-1"),
      FOREMAN
    );
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.ok && plan.followUp, {
      lastReply: "Our answer.",
      replies: ["It still fails."],
    });
  });
});
