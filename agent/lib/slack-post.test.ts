import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  postSlackReply,
  SLACK_MARKDOWN_MAX_LENGTH,
  splitSlackReply,
} from "./slack-post.js";

const LIMIT = 100;

describe("splitSlackReply", () => {
  it("returns a short reply as one unchanged chunk", () => {
    assert.deepEqual(splitSlackReply("hello there", LIMIT), ["hello there"]);
  });

  it("returns no chunks for empty input", () => {
    assert.deepEqual(splitSlackReply("", LIMIT), []);
  });

  it("rejects limits that cannot guarantee progress and surrogate safety", () => {
    for (const limit of [0, -1, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => splitSlackReply("reply", limit),
        new RangeError("limit must be an integer of at least 2")
      );
    }
  });

  it("prefers a paragraph boundary over a line boundary", () => {
    const first = `paragraph one${"a".repeat(60)}`;
    const text = `${first}\n\n${"b".repeat(80)}`;
    const chunks = splitSlackReply(text, LIMIT);
    assert.deepEqual(chunks, [`${first}\n\n`, "b".repeat(80)]);
  });

  it("falls back to a line boundary when the window has no paragraph", () => {
    const first = `line one${"a".repeat(60)}`;
    const text = `${first}\n${"b".repeat(80)}`;
    const chunks = splitSlackReply(text, LIMIT);
    assert.deepEqual(chunks, [`${first}\n`, "b".repeat(80)]);
  });

  it("uses a later line boundary after a leading blank paragraph", () => {
    const text = `\n\nabc\n${"x".repeat(10)}`;
    const chunks = splitSlackReply(text, 10);
    assert.deepEqual(chunks, ["\n\nabc\n", "x".repeat(10)]);
    assert.equal(chunks.join(""), text);
  });

  it("hard-cuts at the limit only when the window has no boundary", () => {
    const text = "a".repeat(LIMIT * 2 + 10);
    const chunks = splitSlackReply(text, LIMIT);
    assert.deepEqual(chunks, [
      "a".repeat(LIMIT),
      "a".repeat(LIMIT),
      "a".repeat(10),
    ]);
  });

  it("preserves the full text across a mixed split", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `section ${index}${"x".repeat(index)}`
    ).join("\n\n");
    const chunks = splitSlackReply(text, LIMIT);
    assert.ok(chunks.length > 2);
    assert.equal(chunks.join(""), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= LIMIT, `chunk of ${chunk.length} over limit`);
    }
  });

  it("never produces a chunk over the 12,000-character Slack limit", () => {
    const text = `${"a".repeat(6000)}\n\n${"b".repeat(6000)}\n\n${"c".repeat(6000)}`;
    const chunks = splitSlackReply(text);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= SLACK_MARKDOWN_MAX_LENGTH);
    }
    assert.equal(chunks.join(""), text);
  });

  it("never splits a UTF-16 surrogate pair across chunks", () => {
    // The emoji sits exactly on the hard cut: without the back-off its two
    // halves would post as separate requests and arrive as U+FFFD.
    const text = `${"a".repeat(LIMIT - 1)}\u{1F600}${"b".repeat(LIMIT)}`;
    const chunks = splitSlackReply(text, LIMIT);
    assert.equal(chunks.join(""), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= LIMIT, `chunk of ${chunk.length} over limit`);
      assert.equal(HIGH_SURROGATE_AT_END.test(chunk), false);
      assert.equal(LOW_SURROGATE_AT_START.test(chunk), false);
    }
    assert.ok(chunks.some((chunk) => chunk.includes("\u{1F600}")));
  });
});

const failingPost = (failures: string[], posts: string[]) => (text: string) => {
  posts.push(text);
  return failures.includes(text)
    ? Promise.reject(new Error("Slack chat.postMessage failed: invalid_blocks"))
    : Promise.resolve({ id: "1700000000.000300" });
};

const INVALID_BLOCKS_ERROR = /Slack chat\.postMessage failed: invalid_blocks/;
const FALLBACK_NAMES_ERROR = /Slack said invalid_blocks/;
const GENERIC_FALLBACK = /could not be posted/;
const RESEND_HINT = /resend/;
const POST_FAILURE_LOG = /Slack reply post failed\./;
const FALLBACK_FAILURE_LOG = /Slack reply fallback post failed\./;
const REJECTED_REPLY = /rejected the reply/;
const HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/u;
const LOW_SURROGATE_AT_START = /^[\uDC00-\uDFFF]/u;

const captureConsoleError = () => {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  return {
    logged,
    restore: () => {
      console.error = original;
    },
  };
};

describe("postSlackReply", () => {
  it("posts every chunk in order", async () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) => `part ${index} ${"x".repeat(3000)}`
    );
    const text = paragraphs.join("\n\n");
    const posts: string[] = [];
    await postSlackReply((chunk) => {
      posts.push(chunk);
      return Promise.resolve({ id: "1" });
    }, text);
    assert.deepEqual(posts, splitSlackReply(text));
    assert.equal(posts.join(""), text);
    assert.ok(posts.length > 1);
  });

  it("posts nothing for empty input", async () => {
    const posts: string[] = [];
    await postSlackReply((chunk) => {
      posts.push(chunk);
      return Promise.resolve({ id: "1" });
    }, "");
    assert.deepEqual(posts, []);
  });

  it("logs the original failure and posts exactly one fallback naming the Slack error", async () => {
    const { logged, restore } = captureConsoleError();
    const posts: string[] = [];
    try {
      const post = failingPost(["too long"], posts);
      await postSlackReply(post, "too long");
    } finally {
      restore();
    }
    assert.equal(posts.length, 2);
    assert.equal(posts[0], "too long");
    assert.match(posts[1], FALLBACK_NAMES_ERROR);
    assert.match(posts[1], RESEND_HINT);
    assert.equal(logged.length, 1);
    assert.match(logged[0], POST_FAILURE_LOG);
    assert.match(logged[0], INVALID_BLOCKS_ERROR);
  });

  it("posts later chunks after earlier ones land and stops at the failure", async () => {
    const { restore } = captureConsoleError();
    const paragraphs = Array.from(
      { length: 6 },
      (_, index) => `part ${index} ${"x".repeat(3000)}`
    );
    const text = paragraphs.join("\n\n");
    const chunks = splitSlackReply(text);
    const posts: string[] = [];
    try {
      const post = failingPost([chunks[1]], posts);
      await postSlackReply(post, text);
    } finally {
      restore();
    }
    assert.deepEqual(posts.slice(0, 2), [chunks[0], chunks[1]]);
    assert.equal(posts.length, 3);
    assert.match(posts[2], REJECTED_REPLY);
  });

  it("keeps non-Slack failures generic so no internals reach the thread", async () => {
    const { restore } = captureConsoleError();
    const posts: string[] = [];
    try {
      await postSlackReply((chunk) => {
        posts.push(chunk);
        return posts.length === 1
          ? Promise.reject(new Error(`broker exploded: ${"x".repeat(1000)}`))
          : Promise.resolve({ id: "1" });
      }, "reply");
    } finally {
      restore();
    }
    assert.equal(posts.length, 2);
    assert.match(posts[1], GENERIC_FALLBACK);
    assert.match(posts[1], RESEND_HINT);
    assert.equal(posts[1].includes("broker exploded"), false);
    assert.ok(posts[1].length <= 300);
  });

  it("falls back to the generic line when a Slack-shaped error code is overlong", async () => {
    const { restore } = captureConsoleError();
    const posts: string[] = [];
    try {
      await postSlackReply((chunk) => {
        posts.push(chunk);
        return posts.length === 1
          ? Promise.reject(
              new Error(`Slack chat.postMessage failed: ${"z".repeat(20_000)}`)
            )
          : Promise.resolve({ id: "1" });
      }, "reply");
    } finally {
      restore();
    }
    assert.equal(posts.length, 2);
    assert.match(posts[1], GENERIC_FALLBACK);
    assert.ok(posts[1].length <= 300);
  });

  it("only logs when the fallback post also fails", async () => {
    const { logged, restore } = captureConsoleError();
    const posts: string[] = [];
    try {
      await postSlackReply((chunk) => {
        posts.push(chunk);
        return Promise.reject(
          new Error("Slack chat.postMessage failed: channel_not_found")
        );
      }, "reply");
    } finally {
      restore();
    }
    assert.equal(posts.length, 2);
    assert.equal(logged.length, 2);
    assert.match(logged[1], FALLBACK_FAILURE_LOG);
  });
});
