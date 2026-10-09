import assert from "node:assert/strict";
import { test } from "node:test";
import { replyElapsed } from "./widget-replay-timing.js";

test("first customer reply ignores progress and empty messages", () => {
  const progress = {
    message: null,
    progress: { checks: [], stage: "investigating" },
  };
  assert.equal(replyElapsed(progress, 1000, 4000), null);
  assert.equal(replyElapsed({ message: " " }, 1000, 4000), null);
  assert.equal(
    replyElapsed({ message: "Here is the answer." }, 1000, 61_000),
    60_000
  );
});
