import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHelpArticles, getHelpArticleContent } from "./help-center.js";

const HTTP_503 = /HTTP 503/u;
const HTTP_500_RE = /HTTP 500/u;

const hit = (n: number) => ({
  content: `<mark>Inbox</mark> ${n}`,
  id: `/docs/ai-sdr/inbox-${n}`,
  type: "page",
  url: `/docs/ai-sdr/inbox-${n}`,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve({ data: body, status });

describe("find_help_article", () => {
  it("reports a missing client as an advisory error", async () => {
    const result = await findHelpArticles("inbox");
    assert.deepEqual(result.articles, []);
    assert.ok(result.error);
  });
  it("passes the typed query, caps at 5, strips marks, and maps paths", async () => {
    let calledUrl = "";
    const result = await findHelpArticles("connect Google inbox & calendar", {
      client: (request) => {
        calledUrl = "query" in request.input ? request.input.query : "";
        return json([
          { ...hit(0), type: "heading" },
          ...[1, 2, 3, 4, 5, 6].map(hit),
        ]);
      },
      linkBaseUrl: "https://example.test",
    });
    assert.equal(calledUrl, "connect Google inbox & calendar");
    assert.equal(result.error, undefined);
    assert.equal(result.articles.length, 5);
    assert.ok(
      result.articles.every((article) => !article.path.endsWith("inbox-0.mdx"))
    );
    assert.deepEqual(result.articles[0], {
      path: "apps/web/content/docs/ai-sdr/inbox-1.mdx",
      title: "Inbox 1",
      url: "https://example.test/docs/ai-sdr/inbox-1",
    });
  });

  it("returns error rather than throwing on a non-2xx response", async () => {
    const result = await findHelpArticles("inbox", {
      client: () => json({ message: "nope" }, 503),
      linkBaseUrl: "https://example.test",
    });
    assert.deepEqual(result.articles, []);
    assert.match(result.error ?? "", HTTP_503);
  });

  it("returns error for a malformed base url instead of throwing", async () => {
    const result = await findHelpArticles("inbox", {
      client: () => json([]),
      linkBaseUrl: "not a url",
    });
    assert.deepEqual(result.articles, []);
    assert.ok(result.error);
  });

  it("treats an empty hit list as a valid answer", async () => {
    const result = await findHelpArticles("zzz", {
      client: () => json([]),
      linkBaseUrl: "https://example.test",
    });
    assert.deepEqual(result, { articles: [] });
  });
});

describe("get_help_article_content", () => {
  const base = "https://app.acquisity.ai";
  const reply = (body: unknown, status = 200) =>
    Promise.resolve({
      json: () => Promise.resolve(body),
      ok: status >= 200 && status < 300,
      status,
    });

  it("rejects a non-help-center url without fetching", async () => {
    let called = false;
    const result = await getHelpArticleContent("https://evil.example/docs/x", {
      baseUrl: base,
      fetch: () => {
        called = true;
        return reply({});
      },
    });
    assert.equal(called, false);
    assert.ok("error" in result);
  });

  it("rejects a same-origin non-docs path without fetching", async () => {
    let called = false;
    const result = await getHelpArticleContent(
      "https://app.acquisity.ai/dashboard/x",
      {
        baseUrl: base,
        fetch: () => {
          called = true;
          return reply({});
        },
      }
    );
    assert.equal(called, false);
    assert.ok("error" in result);
  });

  it("fetches by slug and returns the article content", async () => {
    let calledUrl = "";
    const result = await getHelpArticleContent(
      "https://app.acquisity.ai/docs/cold-email-agent/faq",
      {
        baseUrl: base,
        fetch: (input) => {
          calledUrl = input;
          return reply({
            content: "# FAQ\nbody",
            title: "FAQ",
            url: "/docs/cold-email-agent/faq",
          });
        },
      }
    );
    assert.equal(
      calledUrl,
      "https://app.acquisity.ai/api/docs-content?id=cold-email-agent%2Ffaq"
    );
    assert.ok(!("error" in result));
    if (!("error" in result)) {
      assert.equal(result.content, "# FAQ\nbody");
      assert.equal(result.title, "FAQ");
      assert.equal(
        result.url,
        "https://app.acquisity.ai/docs/cold-email-agent/faq"
      );
    }
  });

  it("accepts a relative /docs url", async () => {
    let calledUrl = "";
    const result = await getHelpArticleContent("/docs/a/b", {
      baseUrl: base,
      fetch: (input) => {
        calledUrl = input;
        return reply({ content: "x", url: "/docs/a/b" });
      },
    });
    assert.equal(
      calledUrl,
      "https://app.acquisity.ai/api/docs-content?id=a%2Fb"
    );
    assert.ok(!("error" in result));
  });

  it("maps 404 to a not-found error", async () => {
    const result = await getHelpArticleContent(
      "https://app.acquisity.ai/docs/missing",
      { baseUrl: base, fetch: () => reply({ error: "not found" }, 404) }
    );
    assert.ok("error" in result);
  });

  it("returns an error on a non-2xx response rather than throwing", async () => {
    const result = await getHelpArticleContent(
      "https://app.acquisity.ai/docs/x",
      { baseUrl: base, fetch: () => reply({}, 500) }
    );
    assert.ok("error" in result && HTTP_500_RE.test(result.error));
  });
});
