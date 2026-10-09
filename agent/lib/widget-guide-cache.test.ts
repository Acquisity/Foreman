import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedGuideText, guideCallKey } from "./widget-guide-cache.js";

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
