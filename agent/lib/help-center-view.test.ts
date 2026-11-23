import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getHelpArticleContent,
  readHelpIndex,
  searchHelpPages,
} from "./help-center.js";
import {
  answerFromHelpCenter,
  type KbDeps,
  REPLY_PROMPT,
  writerCustomer,
} from "./widget-kb.js";

const articles = [
  { title: "Setup", url: "https://app.acquisity.ai/docs/ai-sdr/setup" },
];
const log = { conversationId: "c", runId: "r" };

const deps = (answer: unknown): KbDeps => ({
  generate: () => Promise.resolve(answer),
  ground: ({ reply }) => Promise.resolve({ reply }),
  index: () => Promise.resolve(null),
  read: (url) => Promise.resolve({ content: "body", title: url, url }),
  rewrite: () => Promise.resolve({ queries: ["ai sdr setup"] }),
  search: () => Promise.resolve(articles),
  select: () => assert.fail("no index, so nothing to select from"),
});

const helpCenter = {
  featuresOff: [
    {
      feature: "deliverability",
      pages: ["cold-email-agent/deliverability"],
      title: "Deliverability",
    },
  ],
  viewer: "signed.help.viewer",
};

test("every help-center read is as the customer sees it", async () => {
  const views: [string, unknown][] = [];
  await answerFromHelpCenter(
    "q",
    log,
    {
      ...deps({ reply: "Hi.", sources: [] }),
      index: (_signal, view) => {
        views.push(["index", view]);
        return Promise.resolve(null);
      },
      read: (url, _signal, view) => {
        views.push(["read", view]);
        return Promise.resolve({ content: "body", title: "t", url });
      },
      search: (_query, _signal, view) => {
        views.push(["search", view]);
        return Promise.resolve(articles.slice(0, 1));
      },
    },
    { canInvestigate: false, helpCenter, role: "member", workspace: "w" }
  );
  assert.deepEqual([...new Set(views.map(([read]) => read))].sort(), [
    "index",
    "read",
    "search",
  ]);
  assert.ok(views.every(([, view]) => view === helpCenter));
});

test("the writer gets the features that are off by name, never the viewer token, and is told not to explain them", () => {
  const customer = {
    canInvestigate: false,
    helpCenter,
    role: "member",
    workspace: "w",
  };
  assert.deepEqual(writerCustomer(customer), {
    canInvestigate: false,
    featuresOff: ["Deliverability"],
    role: "member",
    workspace: "w",
  });
  assert.deepEqual(
    writerCustomer({
      ...customer,
      helpCenter: { ...helpCenter, featuresOff: [] },
    }),
    { canInvestigate: false, role: "member", workspace: "w" }
  );
  assert.ok(REPLY_PROMPT.includes("not turned on for their workspace"));
});

test("the index, search and article reads send the customer's view, and the index is cached per view, never shared with the signed-out view", async (t) => {
  const sent: { headers: Headers; url: string }[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), url: String(url) });
    const path = new URL(String(url)).pathname;
    return Promise.resolve(
      path === "/api/docs-content"
        ? Response.json({ content: "body", title: "t", url: "x" })
        : Response.json(
            path === "/api/docs-index"
              ? [{ id: `page-${sent.length}`, title: "t" }]
              : []
          )
    );
  });
  const signal = AbortSignal.timeout(5000);
  const allOn = { ...helpCenter, featuresOff: [] };
  const signedOut = await readHelpIndex(signal);
  const viewed = await readHelpIndex(signal, helpCenter);
  const everything = await readHelpIndex(signal, allOn);
  assert.notDeepEqual(viewed, signedOut);
  assert.notDeepEqual(everything, signedOut);
  assert.deepEqual(await readHelpIndex(signal, helpCenter), viewed);
  assert.deepEqual(await readHelpIndex(signal), signedOut);
  await searchHelpPages("inbox placement", signal, helpCenter, 4);
  await getHelpArticleContent(
    "https://app.acquisity.ai/docs/cold-email-agent/deliverability",
    { signal, view: helpCenter }
  );
  assert.deepEqual(
    sent.map((request) => [
      new URL(request.url).pathname,
      request.headers.get("x-help-viewer"),
    ]),
    [
      ["/api/docs-index", null],
      ["/api/docs-index", helpCenter.viewer],
      ["/api/docs-index", helpCenter.viewer],
      ["/api/search", helpCenter.viewer],
      ["/api/docs-content", helpCenter.viewer],
    ]
  );
});
