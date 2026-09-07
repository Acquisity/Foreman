import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findHelpArticles } from "./help-center.js";

const HTTP_503 = /HTTP 503/u;

const hit = (n: number) => ({
  content: `<mark>Inbox</mark> ${n}`,
  id: `/docs/ai-sdr/inbox-${n}`,
  type: "page",
  url: `/docs/ai-sdr/inbox-${n}`,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve({ data: body, status });

describe("find_help_article", () => {
  it("passes the typed query, caps at 5, strips marks, and maps paths", async () => {
    let calledUrl = "";
    const result = await findHelpArticles("connect Google inbox & calendar", {
      baseUrl: "https://example.test",
      client: (request) => {
        calledUrl = "query" in request.input ? request.input.query : "";
        return json([
          { ...hit(0), type: "heading" },
          ...[1, 2, 3, 4, 5, 6].map(hit),
        ]);
      },
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
      baseUrl: "https://example.test",
      client: () => json({ message: "nope" }, 503),
    });
    assert.deepEqual(result.articles, []);
    assert.match(result.error ?? "", HTTP_503);
  });

  it("returns error for a malformed base url instead of throwing", async () => {
    const result = await findHelpArticles("inbox", {
      baseUrl: "not a url",
      client: () => json([]),
    });
    assert.deepEqual(result.articles, []);
    assert.ok(result.error);
  });

  it("treats an empty hit list as a valid answer", async () => {
    const result = await findHelpArticles("zzz", {
      baseUrl: "https://example.test",
      client: () => json([]),
    });
    assert.deepEqual(result, { articles: [] });
  });
});
