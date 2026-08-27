import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPLY_MARKER, replyOf } from "./slack-reply.js";

describe("replyOf", () => {
  it("returns the whole message trimmed when there is no marker", () => {
    assert.equal(replyOf("  Hello there.\n"), "Hello there.");
  });

  it("returns only the text after the marker", () => {
    assert.equal(
      replyOf(
        `The investigation is complete.\n${REPLY_MARKER}\nNo duplicate charge.`
      ),
      "No duplicate charge."
    );
  });

  it("trims blank lines around the reply", () => {
    assert.equal(
      replyOf(`Narration\n\n${REPLY_MARKER}\n\n\nReply text\n\n`),
      "Reply text"
    );
  });

  it("keeps a second marker inside the reply", () => {
    assert.equal(
      replyOf(
        `Narration\n${REPLY_MARKER}\nWrite ${REPLY_MARKER} on its own line.`
      ),
      `Write ${REPLY_MARKER} on its own line.`
    );
  });
});
