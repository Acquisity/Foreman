import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeArticleHits,
  answerFromHelpCenter,
  defaultKbDeps,
  GROUND_PROMPT,
  hedged,
  indexLine,
  type KbDeps,
  loadImages,
  MAX_LOOKUPS,
  mergeHits,
  REPLY_PROMPT,
  renderTranscript,
  resolveCitations,
  SELECT_PROMPT,
  stepsOnOwnLines,
} from "./widget-kb.js";

const TRY_AGAIN = /try your message again/u;
const GROUND_MS = /^ms=\d+$/u;
const GENERATE_529 =
  /^step=generate attempt=1 reason=AI_APICallError:529 ms=\d+$/;

const articles = [
  { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
  { title: "Settings", url: "https://app.acquisity.ai/docs/ai-sdr/settings" },
  { title: "Availability", url: "https://app.acquisity.ai/docs/availability" },
];
const log = { conversationId: "c", runId: "r" };

/** A writer that searches once and reads what it found, as the prompt asks. */
const writer =
  (answer: unknown) =>
  async ({ lookup }: Parameters<KbDeps["generate"]>[0]) => {
    const attempt = lookup();
    const found = (await attempt.search("q")) as {
      results?: { url: string }[];
    };
    for (const hit of (found.results ?? []).slice(0, MAX_LOOKUPS - 1)) {
      // biome-ignore lint/performance/noAwaitInLoops: reads in order, as the model does.
      await attempt.read(hit.url);
    }
    return { articles: attempt.articles, reply: answer };
  };

const deps = (answer: unknown, hits = articles): KbDeps => ({
  generate: writer(answer),
  ground: ({ reply }) => Promise.resolve({ reply }),
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
    deps({ reply: "Connect your calendar [1].", sources: [] })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar.",
  });
});

test("the checked reply replaces the writer's, and its citations resolve against the checked text", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const seen: { articles: number; reply: string }[] = [];
  const result = await answerFromHelpCenter(
    "where is the ai sdr calendar?",
    log,
    {
      ...deps({
        reply: "Open settings [2]. It cannot be turned off [3].",
        sources: [],
      }),
      ground: ({ articles: read, reply }) => {
        seen.push({ articles: read.length, reply });
        return Promise.resolve({
          reply:
            "Open settings [2]. I'm not sure whether it can be turned off.",
        });
      },
    }
  );
  assert.deepEqual(seen, [
    { articles: 3, reply: "Open settings [2]. It cannot be turned off [3]." },
  ]);
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Settings", url: articles[1].url }],
    message: "Open settings. I'm not sure whether it can be turned off.",
  });
  const ground = lines
    .map((line) => JSON.parse(line))
    .find((line) => line.event === "widget.kb.ground");
  assert.equal(ground?.outcome, "changed");
  assert.match(ground?.message, GROUND_MS);
});

test("a check that trimmed away the answer sends its short honest reply instead", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const asked: string[] = [];
  const result = await answerFromHelpCenter("can I use Calendly there?", log, {
    ...deps({ reply: "Yes, paste your Calendly link [1].", sources: [] }),
    ground: ({ question }) => {
      asked.push(question);
      return Promise.resolve({
        notSure:
          "I'm not sure a Calendly link works there. Which page are you on?",
        reply: "",
        stillAnswers: false,
        unsupported: ["Yes, paste your Calendly link"],
      });
    },
  });
  assert.deepEqual(asked, ["Customer: can I use Calendly there?"]);
  assert.deepEqual(result, {
    citations: [],
    message: "I'm not sure a Calendly link works there. Which page are you on?",
  });
  assert.ok(
    lines.some(
      (line) =>
        JSON.parse(line).event === "widget.kb.ground" &&
        JSON.parse(line).outcome === "replaced"
    )
  );
});

test("a failed or empty check sends the writer's reply as written", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  for (const ground of [
    () => Promise.reject(new Error("timeout")),
    () => Promise.resolve({ reply: "  " }),
    () => Promise.resolve({ nope: true }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: cases are independent and tiny.
    const result = await answerFromHelpCenter("q", log, {
      ...deps({ reply: "Open settings [2]. Then save [1].", sources: [] }),
      ground,
    });
    assert.deepEqual(result, {
      citations: [
        { n: 1, title: "Settings", url: articles[1].url },
        { n: 2, title: "Setup", url: articles[0].url },
      ],
      message: "Open settings [1]. Then save [2].",
    });
  }
  assert.deepEqual(
    lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "widget.kb.ground")
      .map((line) => line.outcome),
    ["fallback", "fallback", "fallback"]
  );
});

test("a reply that cites nothing is delivered as written, with or without articles", async () => {
  for (const hits of [[], articles]) {
    // biome-ignore lint/performance/noAwaitInLoops: cases are independent and tiny.
    const result = await answerFromHelpCenter(
      "q",
      log,
      deps({ reply: "I'm not sure. Which page are you on?", sources: [] }, hits)
    );
    assert.deepEqual(result, {
      citations: [],
      message: "I'm not sure. Which page are you on?",
    });
  }
});

test("an empty reply is a technical failure: the customer is asked to send it again", async () => {
  const result = await answerFromHelpCenter(
    "q",
    log,
    deps({ reply: " [1] ", sources: [] }, [])
  );
  assert.match(result.message, TRY_AGAIN);
});

test("an answer without markers is kept when it lists its sources, and only real ones", async () => {
  const result = await answerFromHelpCenter(
    "q",
    log,
    deps({
      reply: "Connect your calendar.",
      sources: [1, 1, 9],
    })
  );
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Setup", url: articles[0].url }],
    message: "Connect your calendar.",
  });
  assert.deepEqual(
    await answerFromHelpCenter(
      "q",
      log,
      deps({ reply: "Just trust me.", sources: [9] })
    ),
    { citations: [], message: "Just trust me." }
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

test("the message is searched as keyword queries, and as the writer's query when the rewrite fails", async () => {
  const searched: string[] = [];
  const base = deps({ reply: "Do this [1].", sources: [] });
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
  assert.deepEqual(searched, ["q"]);
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
    reply: "Open Add New Inboxes [1].",
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
    select: () =>
      Promise.resolve({
        articles: [2, 2, 99].map((n) => ({ fit: "direct", n })),
      }),
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
  assert.equal(result.citations[0].title, "Buying inboxes");

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
    assert.equal(fallback.citations[0].title, "Setup");
  }
});

test("search_help_center returns each pick with its fit, and names the previous citation to the selector", async () => {
  const index = [
    { id: "ai-sdr/setup", title: "Setup" },
    { id: "ai-sdr/settings", title: "Settings" },
    { id: "availability", title: "Availability" },
  ];
  const selected: string[] = [];
  let found: unknown = null;
  await answerFromHelpCenter(
    {
      activeArticles: [{ title: "Settings", url: articles[1].url }],
      latest: "where do i set the ai sdr calendar?",
    },
    log,
    {
      ...deps(null),
      generate: async ({ lookup }) => {
        const attempt = lookup();
        found = await attempt.search("ai sdr calendar");
        return { articles: [], reply: { reply: "I'm not sure.", sources: [] } };
      },
      index: () => Promise.resolve(index),
      search: () => assert.fail("a pick that found articles never searches"),
      select: ({ question }) => {
        selected.push(question);
        return Promise.resolve({
          articles: [
            { fit: "direct", n: 3 },
            { fit: "related", n: 1 },
          ],
        });
      },
    }
  );
  assert.deepEqual(found, {
    results: [
      { fit: "direct", title: "Availability", url: articles[2].url },
      { fit: "related", title: "Setup", url: articles[0].url },
    ],
  });
  assert.ok(selected[0].includes("Looking up: ai sdr calendar"));
  assert.ok(selected[0].endsWith("Articles the previous reply cited: 2"));
});

test("an article the writer read is citable and is what the check receives; one it did not read is not", async () => {
  const checked: string[][] = [];
  const result = await answerFromHelpCenter("where are my hours?", log, {
    ...deps(null),
    generate: async ({ lookup }) => {
      const attempt = lookup();
      await attempt.read(articles[2].url);
      return {
        articles: attempt.articles,
        reply: { reply: "Set your hours [1]. Also see [2].", sources: [] },
      };
    },
    ground: ({ articles: read, reply }) => {
      checked.push(read.map((article) => article.url));
      return Promise.resolve({ reply });
    },
  });
  assert.deepEqual(checked, [[articles[2].url]]);
  assert.deepEqual(result, {
    citations: [{ n: 1, title: "Availability", url: articles[2].url }],
    message: "Set your hours. Also see.",
  });
});

test("a failing lookup is answered around, never an empty reply, and a fifth lookup is refused", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const got: unknown[] = [];
  const result = await answerFromHelpCenter("q", log, {
    ...deps(null),
    generate: async ({ lookup }) => {
      const attempt = lookup();
      for (let n = 0; n < MAX_LOOKUPS + 1; n += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: lookups run in order, as the model makes them.
        got.push(await attempt.search("q"));
      }
      return {
        articles: attempt.articles,
        reply: { reply: "I'm not sure. Which page are you on?", sources: [] },
      };
    },
    index: () => Promise.reject(new Error("down")),
    rewrite: () => Promise.reject(new Error("down")),
    search: () => Promise.reject(new Error("down")),
  });
  assert.equal(result.message, "I'm not sure. Which page are you on?");
  assert.deepEqual(
    got.slice(0, MAX_LOOKUPS),
    new Array(MAX_LOOKUPS).fill({ results: [] })
  );
  assert.deepEqual(got[MAX_LOOKUPS], {
    error: "No lookups left for this reply: answer from what you read.",
  });
  const read = await answerFromHelpCenter("q", log, {
    ...deps(null),
    generate: async ({ lookup }) => {
      const attempt = lookup();
      got.push(await attempt.read("https://evil.example/docs/x"));
      got.push(await attempt.read(articles[0].url));
      return {
        articles: attempt.articles,
        reply: { reply: "I'm not sure.", sources: [] },
      };
    },
    read: () => Promise.reject(new Error("timeout")),
  });
  assert.equal(read.message, "I'm not sure.");
  assert.deepEqual(got.slice(-2), [
    { error: "Only a help-center article url can be read." },
    { error: "The help center could not be reached." },
  ]);
  assert.ok(
    lines.some((line) =>
      JSON.parse(line).message?.includes(
        "generate:search,search,search,search,search"
      )
    )
  );
});

test("the writer looks things up on product questions only, at most four times", () => {
  assert.ok(
    REPLY_PROMPT.includes(
      "On any question about how the product works, call search_help_center first"
    )
  );
  assert.ok(
    REPLY_PROMPT.includes(
      "A thanks, greeting, reaction or other chat, and a referral to the AI Consultant, need no lookup."
    )
  );
  assert.ok(REPLY_PROMPT.includes(`at most ${MAX_LOOKUPS} lookups`));
});

test("a reaction gets a short conversational reply with no citations, not an investigation", async () => {
  const result = await answerFromHelpCenter(
    "oh thats cool",
    log,
    deps(
      {
        reply: "Glad that helps! Anything else you want to set up? [1]",
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
  reply: "Next, set your hours [1].",
  sources: [],
};

for (const [latest, screenshots] of [
  ["okay, what next?", undefined],
  // A screenshot with no text, as the app words it, and one sent with just "?":
  // the carried guides are still offered, like any message.
  [
    "(The customer sent only the screenshot below, with no message.)",
    ["Screen: All Campaigns"],
  ],
  ["?", ["Screen: All Campaigns"]],
] as const) {
  test(`every message offers the articles the previous reply cited, readable without a search: ${latest}`, async () => {
    const result = await answerFromHelpCenter(
      {
        activeArticles: [articles[0]],
        latest,
        ...(screenshots ? { screenshots: [...screenshots] } : {}),
      },
      log,
      {
        ...deps(null, [articles[2]]),
        generate: async ({ lookup, previousArticles }) => {
          assert.deepEqual(
            previousArticles.map((article) => article.url),
            [articles[0].url]
          );
          const attempt = lookup();
          await attempt.read(previousArticles[0].url);
          return {
            articles: attempt.articles,
            reply: { reply: "Set your hours [1].", sources: [] },
          };
        },
      }
    );
    assert.deepEqual(
      result.citations.map((c) => c.url),
      [articles[0].url]
    );
  });
}

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

test("the writer is told who is asking, from the verified scope", async () => {
  const told: unknown[] = [];
  const customer = {
    canInvestigate: false,
    role: "member",
    workspace: "Trivox AI",
  };
  await answerFromHelpCenter(
    "q",
    log,
    {
      ...deps(null),
      generate: (input) => {
        told.push(input.customer);
        return Promise.resolve({
          articles: [],
          reply: { reply: "Hi.", sources: [] },
        });
      },
    },
    customer
  );
  assert.deepEqual(told, [{ ...customer, glassOffered: false }]);
});

test("once a reply offered the magnifying glass, the writer and the check are told so", async () => {
  const told: unknown[] = [];
  await answerFromHelpCenter(
    {
      latest: "i still cant scroll",
      turns: [
        { role: "customer", text: "i cant scroll" },
        {
          role: "assistant",
          text: "Tap the magnifying glass next to the message box to start a look into your workspace.",
        },
      ],
    },
    log,
    {
      ...deps(null),
      generate: (input) => {
        told.push(input.customer);
        return Promise.resolve({
          articles: [],
          reply: { reply: "Try Page Down.", sources: [] },
        });
      },
      ground: ({ customer, reply }) => {
        told.push(customer);
        return Promise.resolve({ reply });
      },
    },
    { canInvestigate: true, role: "owner", workspace: "Trivox AI" }
  );
  assert.deepEqual(
    told.map(
      (customer) => (customer as { glassOffered: boolean }).glassOffered
    ),
    [true, true]
  );
});
test("each answer logs which articles it read and which it cited", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  await answerFromHelpCenter(
    "how do i set up ai sdr?",
    log,
    deps({ reply: "Open setup [2].", sources: [] })
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
    reply: "Click Add New Inboxes [1].",
    sources: [],
  });
  await answerFromHelpCenter(ask, log, {
    ...base,
    generate: (input) => {
      seen.push(input.question);
      return base.generate(input);
    },
    rewrite: (question, signal) => {
      seen.push(question);
      return base.rewrite(question, signal);
    },
  });
  assert.deepEqual(seen, [transcript, `${transcript}\n\nLooking up: q`]);
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
      reply: "Click Email Accounts [1].",
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
        return Promise.resolve({ articles: [{ fit: "direct", n: 1 }] });
      },
    });
  };
  const loaded: string[][] = [];
  const answered = await run((urls) => {
    loaded.push(urls);
    return Promise.resolve([image]);
  });
  assert.equal(answered.message, "Click Email Accounts.");
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
      defaultKbDeps.generate({
        lookup: () => ({
          articles: [],
          calls: [],
          read: () => Promise.resolve({}),
          search: () => Promise.resolve({}),
        }),
        previousArticles: [],
        question: "Customer: hi",
        signal,
      })
    ),
    ["google/gemini-3.5-flash-lite"]
  );
  assert.deepEqual(
    await used(() =>
      defaultKbDeps.generate({
        images: [{ data: new Uint8Array([1]), mediaType: "image/png" }],
        lookup: () => ({
          articles: [],
          calls: [],
          read: () => Promise.resolve({}),
          search: () => Promise.resolve({}),
        }),
        previousArticles: [],
        question: "Customer: hi",
        signal,
      })
    ),
    ["google/gemini-3.5-flash"]
  );
});

test("only requests for advice or review use AI Consultant articles", () => {
  for (const prompt of [REPLY_PROMPT, SELECT_PROMPT]) {
    assert.ok(
      prompt.includes(
        "only when the customer asks you to give advice or strategy, write or review their copy (what an email, message or offer should say, including how to word one), or assess their campaign performance"
      )
    );
  }
  assert.ok(REPLY_PROMPT.includes("otherwise do not mention it"));
  assert.ok(SELECT_PROMPT.includes("otherwise do not select them"));
});

test("a bare screenshot asks for a goal, while a screenshot follow-up gets the next step", () => {
  assert.ok(
    REPLY_PROMPT.includes(
      "When a screenshot arrives with no question and no earlier customer goal, ask one short question about what they want to do"
    )
  );
  assert.ok(
    REPLY_PROMPT.includes("never infer a task from the page or a warning")
  );
  assert.ok(
    REPLY_PROMPT.includes(
      "when it continues an earlier stated goal, give the next step toward that goal"
    )
  );
});

test("neither Foreman nor people promise action, and the customer starts the workspace look", () => {
  assert.ok(
    REPLY_PROMPT.includes(
      "Never promise that Foreman, a person, a teammate, the team or a queue will look into, see, pick up, act on or follow up on this message"
    )
  );
  assert.ok(
    REPLY_PROMPT.includes(
      "they can tap it and send their message again to start a look into their workspace. Say it as something they do, never that you, we or anyone will take a look. It is offered at most once in a conversation"
    )
  );
  assert.ok(
    GROUND_PROMPT.includes(
      "a mention of the magnifying glass that nextStep or promptFacts does not give"
    )
  );
});
