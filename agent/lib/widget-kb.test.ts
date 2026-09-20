import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeArticleHits,
  answerFromHelpCenter,
  indexLine,
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
  index: () => Promise.resolve(null),
  read: (url) =>
    Promise.resolve({
      content: "body",
      title: hits.find((h) => h.url === url)?.title ?? url,
      url,
    }),
  rewrite: () => Promise.resolve({ queries: ["ai sdr setup"] }),
  search: () => Promise.resolve(hits),
  select: () => assert.fail("no index, so nothing to select from"),
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

test("grouped markers are understood, so every cited source reaches the list", () => {
  const result = resolveCitations(
    "Pre-warmed inboxes are ready on day one [1, 2]. DFY inboxes warm up first [3].",
    articles
  );
  assert.equal(
    result.message,
    "Pre-warmed inboxes are ready on day one [1][2]. DFY inboxes warm up first [3]."
  );
  assert.deepEqual(
    result.citations.map((c) => c.title),
    ["Setup", "Settings", "Availability"]
  );
});

test("one source means no numbers at all; several sources are numbered only where the source changes", () => {
  const result = resolveCitations(
    "1. Open your workspace [1].\n2. Click Website Builder [1].\n3. Write your prompt [1].",
    articles
  );
  assert.equal(
    result.message,
    "1. Open your workspace.\n2. Click Website Builder.\n3. Write your prompt."
  );
  assert.equal(result.citations.length, 1);

  // A marker still appears mid-answer where the source changes.
  assert.equal(
    resolveCitations("A [1]. B [1]. C [2]. D [2].", articles).message,
    "A. B [1]. C. D [2]."
  );
});

test("a grounded answer is returned with the urls of the searched articles only", async () => {
  const result = await answerFromHelpCenter(
    "how do i set up my ai sdr?",
    log,
    deps({ answer: "Connect your calendar [1].", kind: "answer" })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar.",
  });
});

test("no hits, an unanswerable question, an uncited answer, and a failure all fall back to null", async () => {
  const cases: KbDeps[] = [
    deps({ answer: "x [1]", kind: "answer" }, []),
    deps({ answer: "", kind: "none" }),
    deps({ answer: "Just trust me.", kind: "answer" }),
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
  const base = deps({ answer: "Do this [1].", kind: "answer" });
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

test("articles are picked from the title index, with keyword search only as the fallback", async () => {
  const index = [
    { id: "ad-writer", title: "AI Ads Maker" },
    {
      id: "cold-email-agent/email-accounts/buying-inboxes",
      title: "Buying inboxes",
    },
  ];
  const read: string[] = [];
  const base = deps({ answer: "Open Add New Inboxes [1].", kind: "answer" });
  const picking: KbDeps = {
    ...base,
    index: () => Promise.resolve(index),
    read: (url) => {
      read.push(url);
      return Promise.resolve({ content: "body", title: "Buying inboxes", url });
    },
    search: () => assert.fail("must not search when the index answers"),
    select: () => Promise.resolve({ articles: [2, 2, 99] }),
  };
  const result = await answerFromHelpCenter(
    "how do i add inboxes?",
    log,
    picking
  );
  assert.equal(read.length, 1);
  assert.equal(
    new URL(read[0]).pathname,
    "/docs/cold-email-agent/email-accounts/buying-inboxes"
  );
  assert.equal(result?.citations[0].title, "Buying inboxes");

  // An empty pick, or a failing one, falls back to keyword search.
  for (const select of [
    () => Promise.resolve({ articles: [] }),
    () => Promise.reject(new Error("gateway down")),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: cases are independent and tiny.
    const fallback = await answerFromHelpCenter("q", log, {
      ...base,
      index: () => Promise.resolve(index),
      select,
    });
    assert.equal(fallback?.citations[0].title, "Setup");
  }
});

test("a reaction gets a short conversational reply with no citations, not an investigation", async () => {
  const result = await answerFromHelpCenter(
    "oh thats cool",
    log,
    deps(
      {
        answer: "Glad that helps! Anything else you want to set up? [1]",
        kind: "chat",
      },
      []
    )
  );
  assert.deepEqual(result, {
    citations: [],
    message: "Glad that helps! Anything else you want to set up?",
  });
});

const grounded = { answer: "Next, set your hours [1].", kind: "answer" };

test("a dependent follow-up reads the article the previous reply cited, without a fresh retrieval", async () => {
  const read: string[] = [];
  const result = await answerFromHelpCenter(
    {
      activeArticles: [articles[0]],
      followUp: true,
      latest: "okay, what next?",
    },
    log,
    {
      ...deps(grounded),
      read: (url) => {
        read.push(url);
        return Promise.resolve({ content: "body", title: "Setup", url });
      },
      rewrite: () => assert.fail("the active article answered"),
      search: () => assert.fail("the active article answered"),
    }
  );
  assert.deepEqual(read, [articles[0].url]);
  assert.deepEqual(
    result?.citations.map((c) => c.url),
    [articles[0].url]
  );
});

test("a new subject ignores the active article, and an active article that cannot answer falls back to one fresh retrieval", async () => {
  const fresh = [articles[2]];
  const read: string[] = [];
  const reading = (answer: (urls: string[]) => unknown): KbDeps => ({
    ...deps(null, fresh),
    generate: ({ articles: given }) =>
      Promise.resolve(answer(given.map((a) => a.url))),
    read: (url) => {
      read.push(url);
      return Promise.resolve({ content: "body", title: "t", url });
    },
  });
  await answerFromHelpCenter(
    {
      activeArticles: [articles[0]],
      followUp: false,
      latest: "how do i set my hours?",
    },
    log,
    reading(() => grounded)
  );
  assert.deepEqual(read, [fresh[0].url]);

  read.length = 0;
  const result = await answerFromHelpCenter(
    { activeArticles: [articles[0]], followUp: true, latest: "and my hours?" },
    log,
    reading((urls) =>
      urls[0] === articles[0].url ? { answer: "", kind: "none" } : grounded
    )
  );
  assert.deepEqual(read, [articles[0].url, fresh[0].url]);
  // The citation supports this answer: it is the article read for it, not the earlier one.
  assert.deepEqual(
    result?.citations.map((c) => c.url),
    [fresh[0].url]
  );
});

test("prior citations are hints only: foreign, malformed and unlisted urls never become something to read", async () => {
  const index = [{ id: "ai-sdr/setup", title: "Setup" }];
  const hits = await activeArticleHits(
    {
      activeArticles: [
        { title: "x", url: "https://evil.example/docs/ai-sdr/setup" },
        { title: "x", url: "https://app.acquisity.ai/api/docs-content?id=x" },
        { title: "x", url: "not a url" },
        { title: "x", url: "https://app.acquisity.ai/docs/not-in-index" },
        {
          title: "x",
          url: "https://app.acquisity.ai/docs/ai-sdr/setup?next=//evil#x",
        },
      ],
      latest: "and then?",
    },
    AbortSignal.timeout(1000),
    { index: () => Promise.resolve(index) }
  );
  assert.deepEqual(hits, [
    { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
  ]);
});

test("the selector sees path, description and keywords, bounded, and an older index still renders", () => {
  assert.equal(
    indexLine(
      {
        description: "d".repeat(500),
        id: "ai-sdr/faq",
        keywords: ["pause", "stop"],
        title: "Frequently Asked Questions",
      },
      0
    ),
    `1. Frequently Asked Questions (ai-sdr/faq): ${"d".repeat(160)} [pause, stop]`
  );
  assert.equal(indexLine({ id: "a", title: "Overview" }, 1), "2. Overview (a)");
});

test("a timeout or error in the lane is a miss, never a blank or partial reply", async () => {
  const result = await answerFromHelpCenter(
    { followUp: true, latest: "what next?" },
    log,
    { ...deps(grounded), generate: () => Promise.reject(new Error("timeout")) }
  );
  assert.equal(result, null);
});
