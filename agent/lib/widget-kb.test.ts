import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeArticleHits,
  answerFromHelpCenter,
  CANNOT_CHECK,
  CANNOT_CHECK_ALONE,
  decideFromArticles,
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

test("no hits, an unanswerable question, and an uncited answer fall back to null", async () => {
  const cases: KbDeps[] = [
    deps({ answer: "x [1]", kind: "answer" }, []),
    deps({ answer: "", kind: "none" }),
    deps({ answer: "Just trust me.", kind: "answer" }),
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

test("a dependent follow-up reads the article the previous reply cited alongside a fresh retrieval, fresh first", async () => {
  const given: string[][] = [];
  const result = await answerFromHelpCenter(
    {
      activeArticles: [articles[0]],
      followUp: true,
      latest: "okay, what next?",
    },
    log,
    {
      ...deps(null, [articles[2]]),
      generate: ({ articles: read }) => {
        given.push(read.map((a) => a.url));
        return Promise.resolve({
          answer: "Set your hours [2].",
          kind: "answer",
        });
      },
    }
  );
  assert.deepEqual(given, [[articles[2].url, articles[0].url]]);
  assert.deepEqual(
    result?.citations.map((c) => c.url),
    [articles[0].url]
  );
});

test("a new subject outweighs the previous citation: scored a follow-up or not, the fresh article is read and cited", async () => {
  const [ticketStatus, , widgetMissing] = articles;
  for (const followUp of [true, false]) {
    // biome-ignore lint/performance/noAwaitInLoops: two independent cases.
    const result = await answerFromHelpCenter(
      {
        activeArticles: [ticketStatus],
        followUp,
        latest:
          "And if the support chat bubble itself is missing, what should I try first?",
      },
      log,
      {
        ...deps(null, [widgetMissing]),
        generate: ({ articles: read }) => {
          // The fresh hit always leads, so the model is never left with only the old article.
          assert.equal(read[0].url, widgetMissing.url);
          return Promise.resolve({
            answer: "Check your ad blocker [1].",
            kind: "answer",
          });
        },
      }
    );
    assert.deepEqual(
      result?.citations.map((c) => c.url),
      [widgetMissing.url]
    );
  }
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

test("a timeout or error reports a technical failure instead of a missing guide", async () => {
  const result = await answerFromHelpCenter(
    { followUp: true, latest: "what next?" },
    log,
    { ...deps(grounded), generate: () => Promise.reject(new Error("timeout")) }
  );
  assert.deepEqual(result, {
    citations: [],
    message:
      "Sorry, the help-center answer could not be loaded just now. Please try your message again.",
  });
});

test("an account-likely ask decides what the message needs first: a fragment is unclear, an account question steps aside, a documented fix is answered", async () => {
  const told: (boolean | undefined)[] = [];
  const lane = (needs: string | undefined): KbDeps => ({
    ...deps(null),
    generate: ({ accountLikely }) => {
      told.push(accountLikely);
      // A model that answers anyway must not get past "needs".
      return Promise.resolve({ answer: "Do this [1].", kind: "answer", needs });
    },
  });
  const guarded = (latest: string, needs: string) =>
    answerFromHelpCenter({ accountLikely: true, latest }, log, lane(needs));
  assert.deepEqual(await guarded("and my dashboard totals", "unclear"), {
    citations: [],
    message: "",
    unclear: true,
  });
  assert.equal(
    await guarded("why is my campaign not sending?", "account"),
    null
  );
  assert.deepEqual(
    (
      await guarded("Google says the app is blocked", "articles")
    )?.citations.map((c) => c.url),
    [articles[0].url]
  );
  // An ordinary ask has no such field and is answered as before.
  assert.ok(
    await answerFromHelpCenter("how do i connect?", log, lane(undefined))
  );
  assert.deepEqual(told, [true, true, true, undefined]);
});

test("Jev decides what the articles can do and the writer only writes when Jev says answer", async () => {
  const written: { accountLikely?: boolean; decided?: boolean }[] = [];
  const lane = (choice: string): KbDeps => ({
    ...deps(null),
    decide: () => Promise.resolve({ choice, confidence: 0.9 } as never),
    generate: ({ accountLikely, decided }) => {
      written.push({ accountLikely, decided });
      return Promise.resolve({ answer: "Do this [1].", kind: "answer" });
    },
  });
  const ask = (choice: string) =>
    answerFromHelpCenter(
      { accountLikely: true, latest: "why is my campaign not sending?" },
      log,
      lane(choice)
    );
  const unclear = { citations: [], message: "", unclear: true };
  assert.deepEqual(await ask("unclear"), unclear);
  assert.deepEqual(await ask("which_product"), unclear);
  assert.equal(await ask("account"), null);
  assert.equal(await ask("not_covered"), null);
  assert.deepEqual(written, []);
  assert.deepEqual(
    (await ask("answer"))?.citations.map((c) => c.url),
    [articles[0].url]
  );
  // Jev already stepped past "needs", so the writer is not asked it again.
  assert.deepEqual(written, [{ accountLikely: undefined, decided: true }]);
});

test("an unsure account pick is answered from the articles; only a sure one steps aside", async () => {
  let writes = 0;
  const lane = (confidence: number): KbDeps => ({
    ...deps(null),
    decide: () => Promise.resolve({ choice: "account", confidence }),
    generate: () => {
      writes += 1;
      return Promise.resolve({ answer: "Do this [1].", kind: "answer" });
    },
  });
  const ask = { accountLikely: true, latest: "why was I charged twice?" };
  assert.ok(await answerFromHelpCenter(ask, log, lane(0.35)));
  assert.equal(writes, 1);
  assert.equal(await answerFromHelpCenter(ask, log, lane(0.9)), null);
  assert.equal(writes, 1);
});

test("a failed Jev decision leaves the call to the writer, as before", async () => {
  const written: (boolean | undefined)[] = [];
  const answer = await answerFromHelpCenter(
    { accountLikely: true, latest: "why is my campaign not sending?" },
    log,
    {
      ...deps(null),
      decide: () => Promise.reject(new Error("timeout")),
      generate: ({ accountLikely, decided }) => {
        written.push(accountLikely, decided);
        return Promise.resolve({ answer: "", kind: "none", needs: "account" });
      },
    }
  );
  assert.equal(answer, null);
  assert.deepEqual(written, [true, false]);
});

test("the Jev decision offers account and unclear only on an account-likely ask, and refuses anything off the menu", async () => {
  const offered: string[][] = [];
  const jev = (choice: string) => (_url: string, init: { body: string }) => {
    offered.push(Object.keys(JSON.parse(init.body).questions.kb.criteria));
    return Promise.resolve({
      json: () =>
        Promise.resolve({ answers: { kb: { choice, confidence: 0.9 } } }),
      ok: true,
      status: 200,
    });
  };
  const input = (accountLikely: boolean) => ({
    accountLikely,
    articles: [{ content: "body", title: "Setup", url: articles[0].url }],
    question: "how do i connect?",
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(
    await decideFromArticles(input(true), {
      apiKey: "k",
      fetch: jev("account"),
    }),
    { choice: "account", confidence: 0.9 }
  );
  await assert.rejects(
    decideFromArticles(input(false), { apiKey: "k", fetch: jev("account") }),
    { message: "invalid_choice" }
  );
  assert.deepEqual(offered, [
    ["answer", "not_covered", "which_product", "account", "unclear"],
    ["answer", "not_covered", "which_product"],
  ]);
  await assert.rejects(decideFromArticles(input(false), { apiKey: "" }), {
    message: "no_key",
  });
});

test("help-center mode answers an ask for a look from the articles, saying first that it cannot check", async () => {
  const lane = (answer: unknown): KbDeps => ({
    ...deps(null),
    decide: () => Promise.resolve({ choice: "account", confidence: 0.9 }),
    generate: () => Promise.resolve(answer),
  });
  const ask = { cannotLook: true, latest: "what campaigns do you see?" };
  const answered = await answerFromHelpCenter(
    ask,
    log,
    lane({ answer: "Open Campaigns [1].", kind: "answer" })
  );
  assert.ok(answered?.message.startsWith(CANNOT_CHECK));
  assert.deepEqual(
    answered?.citations.map((c) => c.url),
    [articles[0].url]
  );
  // The writer's own "I can't access your account" is not said twice.
  const told: unknown[] = [];
  const twice = await answerFromHelpCenter(ask, log, {
    ...lane(null),
    generate: (input) => {
      told.push(input.cannotCheck);
      return Promise.resolve({
        answer:
          "I am not able to access or view your account. Open Campaigns [1].",
        kind: "answer",
      });
    },
  });
  assert.equal(twice?.message, `${CANNOT_CHECK}\n\nOpen Campaigns.`);
  assert.deepEqual(told, [true]);
  // Nothing in the articles: the plain line alone, never a silent miss.
  assert.deepEqual(
    await answerFromHelpCenter(ask, log, lane({ answer: "", kind: "none" })),
    { citations: [], message: CANNOT_CHECK_ALONE }
  );
  // Full mode steps aside for the investigation instead, and never says it.
  assert.equal(
    await answerFromHelpCenter(
      { accountLikely: true, latest: "what campaigns do you see?" },
      log,
      lane({ answer: "Open Campaigns [1].", kind: "answer" })
    ),
    null
  );
});
