import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cachedGuideText,
  checkedGuideCall,
  guideCallKey,
} from "./widget-guide-cache.js";

const BAD_BATCH = /batch 3: Error: bad slug/u;

test("only a batch whose prompt, model or articles changed calls the model again", () => {
  const key = (model: string, system: string, articles: string) =>
    guideCallKey(model, "32000", system, articles);
  const before = [key("m", "prompt", "a1"), key("m", "prompt", "b1")];
  const cache = { [before[0]]: "section a", [before[1]]: "section b" };

  const after = [key("m", "prompt", "a1"), key("m", "prompt", "b2")];
  assert.deepEqual(
    after.map((k) => cachedGuideText(cache, k, false)),
    ["section a", undefined]
  );
  assert.equal(
    cachedGuideText(cache, key("m", "new prompt", "a1"), false),
    undefined
  );
  assert.equal(
    cachedGuideText(cache, key("other", "prompt", "a1"), false),
    undefined
  );
  assert.equal(cachedGuideText(cache, before[0], true), undefined);
  // Joined inputs cannot collide: ("ab", "c") is not ("a", "bc").
  assert.notEqual(guideCallKey("ab", "c"), guideCallKey("a", "bc"));
});

test("a batch that fails its check is distilled again, alone and at most the given times", async () => {
  const check = (text: string) => {
    if (text.startsWith("bad")) {
      throw new Error("bad slug");
    }
    return text.toUpperCase();
  };
  const replies = (texts: string[], fresh = true) => {
    let calls = 0;
    const distill = () => {
      calls += 1;
      return Promise.resolve({ fresh, text: texts[calls - 1] ?? "bad" });
    };
    return { calls: () => calls, distill };
  };

  const recovers = replies(["bad", "good"]);
  assert.deepEqual(
    await checkedGuideCall("batch 3", 3, recovers.distill, check),
    { fresh: true, text: "GOOD" }
  );
  assert.equal(recovers.calls(), 2);

  const fails = replies([]);
  await assert.rejects(
    checkedGuideCall("batch 3", 3, fails.distill, check),
    BAD_BATCH
  );
  assert.equal(fails.calls(), 3);

  const cached = replies([], false);
  await assert.rejects(
    checkedGuideCall("batch 3", 3, cached.distill, check),
    BAD_BATCH
  );
  assert.equal(cached.calls(), 1);
});
