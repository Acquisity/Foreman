import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertGuideCallStopped,
  cachedGuideText,
  checkedGuideCall,
  countedGuideAttempt,
  guideArtifactsEqual,
  guideCallKey,
  joinGuideLimits,
  parseGuideCache,
  splitGuideLimits,
  splitGuideSections,
} from "./widget-guide-cache.js";

const FAILED_BATCH =
  /batch 7: Error: (transport|distill call ended with length)/u;
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

test("guide cache accepts only hash-to-text data and compares pending artifacts", () => {
  const key = guideCallKey("batch");
  const source = JSON.stringify({ [key]: "text" });
  assert.deepEqual(parseGuideCache(source), { [key]: "text" });
  for (const invalid of [
    "[]",
    "null",
    '{"not-a-hash":"text"}',
    JSON.stringify({ [key]: 42 }),
  ]) {
    assert.throws(() => parseGuideCache(invalid));
  }
  const before = { cache: source, guide: "guide" };
  assert.equal(
    guideArtifactsEqual(before, {
      cache: JSON.stringify({ [key]: "text" }, null, 2),
      guide: "guide",
    }),
    true
  );
  assert.equal(
    guideArtifactsEqual(before, { cache: source, guide: "changed" }),
    false
  );
  assert.equal(
    guideArtifactsEqual(before, { cache: "{}", guide: "guide" }),
    false
  );
  assert.equal(
    guideArtifactsEqual(
      {
        cache: source,
        guide: "// from Acquisity aaaaaaaaaaaa.\nGuide at aaaaaaaaaaaa",
      },
      {
        cache: source,
        guide: "// from Acquisity bbbbbbbbbbbb.\nGuide at bbbbbbbbbbbb",
      }
    ),
    true
  );
});

test("transport rejection and truncation retry within one labelled batch budget", async () => {
  for (const failure of ["transport", "length"]) {
    let calls = 0;
    const distill = () => {
      calls += 1;
      if (failure === "transport") {
        return Promise.reject(new Error("transport"));
      }
      assertGuideCallStopped(failure);
      return Promise.resolve({ fresh: true, text: "truncated" });
    };
    // biome-ignore lint/performance/noAwaitInLoops: exercise each independent failure case.
    await assert.rejects(
      checkedGuideCall("batch 7", 3, distill, (text) => text),
      FAILED_BATCH
    );
    assert.equal(calls, 3);
  }
  let calls = 0;
  const result = await checkedGuideCall(
    "batch 8",
    3,
    () => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("transport"));
      }
      assertGuideCallStopped("stop");
      return Promise.resolve({ fresh: true, text: "recovered" });
    },
    (text) => text
  );
  assert.equal(result.text, "recovered");
  assert.equal(calls, 2);
});

test("model attempt counts include failures and successful calls count resolved responses", async () => {
  const stats = { attempts: 0, successfulCalls: 0 };
  let attempts = 0;
  await checkedGuideCall(
    "batch 9",
    3,
    () =>
      countedGuideAttempt(stats, () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new Error("transport"));
        }
        return Promise.resolve({ fresh: true, text: "success" });
      }),
    (text) => text
  );
  assert.deepEqual(stats, { attempts: 3, successfulCalls: 1 });
});

test("a distilled batch splits into one section per article heading", () => {
  const sections = splitGuideSections(
    "preamble\n### A {slug: a}\nGet here: x\n- one\n\n### B {slug: b/c}\n- two\n"
  );
  assert.deepEqual(
    [...sections],
    [
      ["a", "### A {slug: a}\nGet here: x\n- one"],
      ["b/c", "### B {slug: b/c}\n- two"],
    ]
  );
});

test("summary lines go to the first article they cite, so a rerun keeps the others", () => {
  const text = [
    "## Who can do what",
    "",
    "- Only owners bill {slug: b} {slug: a}.",
    "- Members view settings {a}.",
    "- Nobody here {z}.",
    "",
    "## What Acquisity cannot do",
    "",
    "- No undo {slug: a}.",
  ].join("\n");
  const { dropped, limits } = splitGuideLimits(text, ["a", "b"]);
  assert.deepEqual(dropped, ["- Nobody here {z}."]);
  assert.deepEqual(limits.get("a"), {
    cannot: ["- No undo {slug: a}."],
    who: ["- Members view settings {a}."],
  });
  assert.deepEqual(limits.get("b"), {
    cannot: [],
    who: ["- Only owners bill {slug: b} {slug: a}."],
  });
  assert.equal(
    joinGuideLimits(
      [limits.get("a"), limits.get("b")].filter((l) => l !== undefined)
    ),
    "## Who can do what\n\n- Members view settings {a}.\n- Only owners bill {slug: b} {slug: a}.\n\n## What Acquisity cannot do\n\n- No undo {slug: a}."
  );
});
