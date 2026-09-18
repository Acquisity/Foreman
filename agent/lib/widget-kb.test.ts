import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerFromHelpCenter,
  type KbDeps,
  mergeHits,
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
  rewrite: () => Promise.resolve({ queries: ["ai sdr setup"] }),
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

test("hits from several queries merge by agreement and rank, capped at four", () => {
  const hit = (name: string) => ({
    title: name,
    url: `https://x/docs/${name}`,
  });
  const merged = mergeHits([
    [hit("ad-writer"), hit("workspace"), hit("buying-inboxes")],
    [hit("buying-inboxes"), hit("inbox-cost"), hit("pre-warmed")],
    [hit("email-accounts"), hit("buying-inboxes")],
  ]);
  assert.deepEqual(
    merged.map((h) => h.title),
    ["buying-inboxes", "ad-writer", "email-accounts", "workspace"]
  );
});

test("the message is searched as keyword queries, and as itself when the rewrite fails", async () => {
  const searched: string[] = [];
  const base = deps({ answer: "Do this [1].", answerable: true });
  const recording: KbDeps = {
    ...base,
    rewrite: () =>
      Promise.resolve({ queries: ["buy inboxes", " email accounts "] }),
    search: (query, signal) => {
      searched.push(query);
      return base.search(query, signal);
    },
  };
  await answerFromHelpCenter("how do i add inboxes?", log, recording);
  assert.deepEqual(searched, ["buy inboxes", "email accounts"]);

  searched.length = 0;
  await answerFromHelpCenter("how do i add inboxes?", log, {
    ...recording,
    rewrite: () => Promise.reject(new Error("gateway down")),
  });
  assert.deepEqual(searched, ["how do i add inboxes?"]);
});
