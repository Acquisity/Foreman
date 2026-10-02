import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeArticleHits,
  answerFromHelpCenter,
  CANNOT_CHECK,
  CANNOT_CHECK_ALONE,
  decideFromArticles,
  defaultKbDeps,
  hedged,
  indexLine,
  type KbDeps,
  loadImages,
  mergeHits,
  renderTranscript,
  replyToChat,
  resolveCitations,
  stepsOnOwnLines,
} from "./widget-kb.js";

const DECIDE_TIMEOUT_MARK = / decide:fallback:timeout=\d+ /;
const GENERATE_529 =
  /^step=generate attempt=1 reason=AI_APICallError:529 ms=\d+$/;

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

test("a numbered list run into one paragraph comes back one step per line", () => {
  assert.equal(
    resolveCitations(
      "To get more credits: 1. Click Settings [1]. 2. Click Billing [1]. 3. Click Buy More [1].",
      articles
    ).message,
    "To get more credits:\n1. Click Settings.\n2. Click Billing.\n3. Click Buy More."
  );
  assert.equal(
    stepsOnOwnLines("1. Open it.\n2. Save it."),
    "1. Open it.\n2. Save it."
  );
  assert.equal(
    stepsOnOwnLines("Plan 2. costs more than plan 1. does."),
    "Plan 2. costs more than plan 1. does."
  );
  assert.equal(stepsOnOwnLines("Version 1.5 is out."), "Version 1.5 is out.");
});

test("a grounded answer is returned with the urls of the searched articles only", async () => {
  const result = await answerFromHelpCenter(
    "how do i set up my ai sdr?",
    log,
    deps({ answer: "Connect your calendar [1].", kind: "answer", sources: [] })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar.",
  });
});

test("no hits, an unanswerable question, and an uncited answer fall back to null", async () => {
  const cases: KbDeps[] = [
    deps({ answer: "x [1]", kind: "answer", sources: [] }, []),
    deps({ answer: "", kind: "none", sources: [] }),
    deps({ answer: "Just trust me.", kind: "answer", sources: [] }),
  ];
  for (const kbDeps of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: cases are independent and tiny.
    assert.equal(await answerFromHelpCenter("q", log, kbDeps), null);
  }
});

test("an answer without markers is kept when it lists its sources, and only real ones", async () => {
  const result = await answerFromHelpCenter(
    "q",
    log,
    deps({
      answer: "Connect your calendar.",
      kind: "answer",
      sources: [1, 1, 9],
    })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar.",
  });
  assert.equal(
    await answerFromHelpCenter(
      "q",
      log,
      deps({ answer: "Just trust me.", kind: "answer", sources: [9] })
    ),
    null
  );
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
  const base = deps({ answer: "Do this [1].", kind: "answer", sources: [] });
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
  assert.deepEqual(searched, ["Customer: how do i add inboxes?"]);
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
  const base = deps({
    answer: "Open Add New Inboxes [1].",
    kind: "answer",
    sources: [],
  });
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
        sources: [],
      },
      []
    )
  );
  assert.deepEqual(result, {
    citations: [],
    message: "Glad that helps! Anything else you want to set up?",
  });
});

const grounded = {
  answer: "Next, set your hours [1].",
  kind: "answer",
  sources: [],
};

for (const [latest, screenshots] of [
  ["okay, what next?", undefined],
  // A screenshot with no text, as the app words it, and one sent with just "?":
  // the carried guides are still read, after the fresh pick like any message.
  [
    "(The customer sent only the screenshot below, with no message.)",
    ["Screen: All Campaigns"],
  ],
  ["?", ["Screen: All Campaigns"]],
] as const) {
  test(`every message reads the articles the previous reply cited alongside a fresh retrieval, and Jev decides with both: ${latest}`, async () => {
    const given: string[][] = [];
    const decided: string[][] = [];
    const result = await answerFromHelpCenter(
      {
        activeArticles: [articles[0]],
        latest,
        ...(screenshots ? { screenshots: [...screenshots] } : {}),
      },
      log,
      {
        ...deps(null, [articles[2]]),
        decide: ({ articles: read }) => {
          decided.push(read.map((a) => a.url));
          return Promise.resolve({ choice: "answer", confidence: 0.9 });
        },
        generate: ({ articles: read }) => {
          given.push(read.map((a) => a.url));
          return Promise.resolve({
            answer: "Set your hours [2].",
            kind: "answer",
            sources: [],
          });
        },
      }
    );
    const [fresh, carried] = [articles[2].url, articles[0].url];
    assert.deepEqual(given, [[fresh, carried]]);
    assert.deepEqual(decided, given);
    assert.deepEqual(
      result?.citations.map((c) => c.url),
      [articles[0].url]
    );
  });
}

test("a new subject outweighs the previous citation: the fresh article is read first and cited", async () => {
  const [ticketStatus, , widgetMissing] = articles;
  const result = await answerFromHelpCenter(
    {
      activeArticles: [ticketStatus],
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
          sources: [],
        });
      },
    }
  );
  assert.deepEqual(
    result?.citations.map((c) => c.url),
    [widgetMissing.url]
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

test("a timeout or error reports a technical failure instead of a missing guide", async () => {
  const result = await answerFromHelpCenter({ latest: "what next?" }, log, {
    ...deps(grounded),
    generate: () => Promise.reject(new Error("timeout")),
  });
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
      return Promise.resolve({
        answer: "Do this [1].",
        kind: "answer",
        needs,
        sources: [],
      });
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
      return Promise.resolve({
        answer: "Do this [1].",
        kind: "answer",
        sources: [],
      });
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
      return Promise.resolve({
        answer: "Do this [1].",
        kind: "answer",
        sources: [],
      });
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
        return Promise.resolve({
          answer: "",
          kind: "none",
          needs: "account",
          sources: [],
        });
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
    lane({ answer: "Open Campaigns [1].", kind: "answer", sources: [] })
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
        sources: [],
      });
    },
  });
  assert.equal(twice?.message, `${CANNOT_CHECK}\n\nOpen Campaigns.`);
  assert.deepEqual(told, [true]);
  // Nothing in the articles: the plain line alone, never a silent miss.
  assert.deepEqual(
    await answerFromHelpCenter(
      ask,
      log,
      lane({ answer: "", kind: "none", sources: [] })
    ),
    { citations: [], message: CANNOT_CHECK_ALONE }
  );
  // Full mode steps aside for the investigation instead, and never says it.
  assert.equal(
    await answerFromHelpCenter(
      { accountLikely: true, latest: "what campaigns do you see?" },
      log,
      lane({ answer: "Open Campaigns [1].", kind: "answer", sources: [] })
    ),
    null
  );
});
test("each answer logs which articles it read and which it cited", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  await answerFromHelpCenter(
    "how do i set up ai sdr?",
    log,
    deps({ answer: "Open setup [2].", kind: "answer", sources: [] })
  );
  const logged = lines
    .map((line) => JSON.parse(line))
    .find((line) => line.outcome === "articles");
  assert.equal(
    logged?.message,
    "read=ai-sdr/setup,ai-sdr/settings,availability cited=ai-sdr/settings"
  );
  assert.equal(logged?.event, "widget.kb.answer");
  assert.equal(logged?.runId, "r");
});

// Preview cf5f2208: "where do i go from here?" with a screenshot of a Google
// re-authentication warning, two turns after "can i buy more inboxes", was
// answered with Reconnect. Latest-first, with the goal marked "context only".
test("every stage reads the conversation as a transcript, latest message last with its screenshot labelled as in history", async () => {
  const ask = {
    latest: "where do i go from here?",
    screenshots: ["Screen: All Campaigns"],
    turns: [
      { role: "customer" as const, text: "can i buy more inboxes?" },
      { role: "assistant" as const, text: "Open Email Accounts [1]." },
    ],
  };
  const transcript =
    "Customer: can i buy more inboxes?\nSupport: Open Email Accounts [1].\nCustomer: where do i go from here?\n\nScreenshot reading: Screen: All Campaigns";
  assert.equal(renderTranscript(ask), transcript);
  const seen: string[] = [];
  const base = deps({
    answer: "Click Add New Inboxes [1].",
    kind: "answer",
    sources: [],
  });
  await answerFromHelpCenter(ask, log, {
    ...base,
    decide: ({ question }) => {
      seen.push(question);
      return Promise.resolve({ choice: "answer", confidence: 1 });
    },
    generate: (input) => {
      seen.push(input.question);
      return base.generate(input);
    },
    rewrite: (question, signal) => {
      seen.push(question);
      return base.rewrite(question, signal);
    },
  });
  assert.deepEqual(seen, [transcript, transcript, transcript]);
});

test("the selector and the writer look at the screenshots; without them, a load failure or no loader, they read text only", async () => {
  const image = { data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" };
  const seen: { select?: number; generate?: number }[] = [];
  const ask = {
    images: ["https://shots.example/one.jpg"],
    latest: "where do i go from here?",
    screenshots: ["[Screenshot] Screen: All Campaigns"],
  };
  const run = async (images?: KbDeps["images"]) => {
    const record: { select?: number; generate?: number } = {};
    seen.push(record);
    const base = deps({
      answer: "Click Email Accounts [1].",
      kind: "answer",
      sources: [],
    });
    return await answerFromHelpCenter(ask, log, {
      ...base,
      generate: (input) => {
        record.generate = input.images?.length ?? 0;
        return base.generate(input);
      },
      images,
      index: () =>
        Promise.resolve([{ id: "ai-sdr/setup", title: "Email accounts" }]),
      select: (input) => {
        record.select = input.images?.length ?? 0;
        return Promise.resolve({ articles: [1] });
      },
    });
  };
  const loaded: string[][] = [];
  const answered = await run((urls) => {
    loaded.push(urls);
    return Promise.resolve([image]);
  });
  assert.equal(answered?.message, "Click Email Accounts.");
  assert.deepEqual(loaded, [ask.images]);
  await run(() => Promise.reject(new Error("r2 down")));
  await run(undefined);
  assert.deepEqual(seen, [
    { generate: 1, select: 1 },
    { generate: 0, select: 0 },
    { generate: 0, select: 0 },
  ]);
});

test("a screenshot link loads as an image only when it answers with image bytes", async (t) => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const requested: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    requested.push(init);
    if (url.endsWith("/png")) {
      return Promise.resolve(new Response(png));
    }
    if (url.endsWith("/json")) {
      return Promise.resolve(new Response('{"error":"expired"}'));
    }
    if (url.endsWith("/missing")) {
      return Promise.resolve(new Response(png, { status: 404 }));
    }
    return Promise.reject(new Error("network down"));
  });
  const images = await loadImages(
    ["/png", "/json", "/missing", "/down"].map(
      (path) => `https://shots.example${path}`
    ),
    AbortSignal.timeout(1000)
  );
  assert.deepEqual(
    images.map((image) => image.mediaType),
    ["image/png"]
  );
  // A redirect would leave the signed storage link for somewhere else.
  assert.ok(requested.every((init) => init.redirect === "error"));
});

test("a Jev decision that fails logs why in the answer's step marks", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const timeout = new DOMException("slow", "TimeoutError");
  await answerFromHelpCenter("how do i set up ai sdr?", log, {
    ...deps({ answer: "Open setup [2].", kind: "answer", sources: [] }),
    decide: () => Promise.reject(timeout),
  });
  const done = lines
    .map((line) => JSON.parse(line))
    .find((line) => line.outcome === "ok");
  assert.match(done?.message, DECIDE_TIMEOUT_MARK);
});

test("a stalled help-center model call is raced by a second one, and every failed try is logged", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const never = (scoped: AbortSignal) =>
    new Promise<string>((_resolve, reject) =>
      scoped.addEventListener("abort", () => reject(scoped.reason))
    );
  // Stalled: the second call starts after the hedge delay and wins.
  let calls = 0;
  const { signal } = new AbortController();
  assert.equal(
    await hedged(
      "select",
      signal,
      (scoped) => {
        calls += 1;
        return calls === 1 ? never(scoped) : Promise.resolve("second");
      },
      10
    ),
    "second"
  );
  // Failed: the second starts at once, long before the hedge delay.
  const overloaded = Object.assign(new Error("busy"), {
    name: "AI_APICallError",
    statusCode: 529,
  });
  calls = 0;
  const startedAt = Date.now();
  assert.equal(
    await hedged(
      "generate",
      signal,
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(overloaded) : Promise.resolve("ok");
      },
      60_000
    ),
    "ok"
  );
  assert.ok(Date.now() - startedAt < 1000);
  // Both fail: the last reason surfaces, not an AggregateError.
  await assert.rejects(
    hedged("chat", signal, () => Promise.reject(overloaded), 10),
    overloaded
  );
  const logged = lines.map((line) => JSON.parse(line).message);
  assert.ok(logged.some((line) => GENERATE_529.test(line)));
  assert.equal(
    logged.filter((line) => line.startsWith("step=chat ")).length,
    2
  );
  // The loser aborted when the winner finished is not a failure.
  assert.ok(!logged.some((line) => line.startsWith("step=select ")));
});

test("article picking and text answers run on flash-lite, and an answer with screenshots on kbImages", async (t) => {
  t.mock.method(console, "info", () => undefined);
  const key = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test";
  t.after(() => {
    if (key === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = key;
    }
  });
  const models: string[] = [];
  t.mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
    const id = new Headers(init?.headers).get("ai-language-model-id");
    if (id) {
      models.push(id);
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  });
  const used = async (call: () => Promise<unknown>) => {
    models.length = 0;
    await call().catch(() => undefined);
    return [...new Set(models)];
  };
  const signal = AbortSignal.timeout(5000);
  const index = [{ id: "a", title: "Buying inboxes" }];
  assert.deepEqual(
    await used(() =>
      defaultKbDeps.select({ index, question: "Customer: hi", signal })
    ),
    ["google/gemini-3.5-flash-lite"]
  );
  assert.deepEqual(
    await used(() =>
      defaultKbDeps.generate({ articles: [], question: "Customer: hi", signal })
    ),
    ["google/gemini-3.5-flash-lite"]
  );
  assert.deepEqual(
    await used(() =>
      defaultKbDeps.generate({
        articles: [],
        images: [{ data: new Uint8Array([1]), mediaType: "image/png" }],
        question: "Customer: hi",
        signal,
      })
    ),
    ["google/gemini-3.5-flash"]
  );
  assert.deepEqual(await used(() => replyToChat("thanks", log)), [
    "google/gemini-3.5-flash-lite",
  ]);
});
