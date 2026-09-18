import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerFromHelpCenter,
  type KbDeps,
  resolveCitations,
} from "./widget-kb.js";

const articles = [
  { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
  { title: "Settings", url: "https://app.acquisity.ai/docs/ai-sdr/settings" },
  { title: "Availability", url: "https://app.acquisity.ai/docs/availability" },
];
const log = { conversationId: "c", runId: "r" };

const deps = (answer: unknown, hits = articles): KbDeps => ({
  generate: () => Promise.resolve(answer),
  read: (url) =>
    Promise.resolve({
      content: "body",
      title: hits.find((h) => h.url === url)?.title ?? url,
      url,
    }),
  search: () => Promise.resolve(hits),
});

test("citations are renumbered by first use, and markers for unknown articles are dropped", () => {
  const result = resolveCitations(
    "Set your hours [3]. Connect a calendar [1] [9]. Hours again [3].",
    articles
  );
  assert.equal(
    result.message,
    "Set your hours [1]. Connect a calendar [2]. Hours again [1]."
  );
  assert.deepEqual(
    result.citations.map((c) => [c.n, c.title]),
    [
      [1, "Availability"],
      [2, "Setup"],
    ]
  );
});

test("a grounded answer is returned with the urls of the searched articles only", async () => {
  const result = await answerFromHelpCenter(
    "how do i set up my ai sdr?",
    log,
    deps({ answer: "Connect your calendar [1].", answerable: true })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar [1].",
  });
});

test("no hits, an unanswerable question, an uncited answer, and a failure all fall back to null", async () => {
  const cases: KbDeps[] = [
    deps({ answer: "x [1]", answerable: true }, []),
    deps({ answer: "", answerable: false }),
    deps({ answer: "Just trust me.", answerable: true }),
    {
      ...deps(null),
      generate: () => Promise.reject(new Error("gateway down")),
    },
  ];
  for (const kbDeps of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: cases are independent and tiny.
    assert.equal(await answerFromHelpCenter("q", log, kbDeps), null);
  }
});
