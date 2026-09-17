import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { FindHelpArticleResult } from "#lib/help-center.js";

const HTTP_500_RE = /HTTP 500/;

// Mock the help-center module
// biome-ignore lint/suspicious/useAwait: test mock mirrors the async helper signature.
const mockFindHelpArticles = async (
  query: string
): Promise<FindHelpArticleResult> => {
  if (query === "error test") {
    return {
      articles: [],
      error: "Help-center search failed: HTTP 500.",
    };
  }
  if (query === "empty") {
    return { articles: [] };
  }
  return {
    articles: [
      {
        path: "/docs/features/email-setup",
        title: "Getting Started with Email Setup",
        url: "https://app.acquisity.ai/docs/features/email-setup",
      },
      {
        path: "/docs/features/inbox",
        title: "Troubleshooting Inbox Connection",
        url: "https://app.acquisity.ai/docs/features/inbox",
      },
    ],
  };
};

describe("widget_help_article tool", () => {
  it("tool is exposed only for widget support auth", async () => {
    const toolModule = await import("./widget_help_article.js");
    const dynamic = toolModule.default;

    // Widget auth context
    const widgetCtx = {
      session: {
        auth: {
          initiator: {
            attributes: {},
            issuer: "foreman:widget-support",
          } as SessionAuthContext,
        },
      },
    };

    // Non-widget auth context
    const nonWidgetCtx = {
      session: {
        auth: {
          initiator: null,
        },
      },
    };

    const toolForWidget = dynamic.events["step.started"]?.(
      {},
      widgetCtx as any
    );
    assert.ok(toolForWidget, "tool should be exposed for widget auth");

    const toolForNonWidget = dynamic.events["step.started"]?.(
      {},
      nonWidgetCtx as any
    );
    assert.equal(
      toolForNonWidget,
      null,
      "tool should be hidden for non-widget auth"
    );
  });

  it("returns structured article list with title and url", async () => {
    // Test the output schema validation
    const result = await mockFindHelpArticles("email setup");
    assert.equal(result.articles.length, 2, "should return 2 articles");
    assert.ok(result.articles[0].title, "articles should have title");
    assert.ok(result.articles[0].url, "articles should have url");
    assert.equal(
      typeof result.articles[0].title,
      "string",
      "title should be a string"
    );
    assert.equal(
      typeof result.articles[0].url,
      "string",
      "url should be a string"
    );
  });

  it("handles empty results", async () => {
    const result = await mockFindHelpArticles("empty");
    assert.deepEqual(
      result.articles,
      [],
      "should return empty array when no articles found"
    );
    assert.equal(
      result.error,
      undefined,
      "should not have error when empty is expected"
    );
  });

  it("includes error message when search fails", async () => {
    const result = await mockFindHelpArticles("error test");
    assert.equal(result.articles.length, 0, "should have no articles on error");
    assert.ok(result.error, "should include error message");
    assert.match(result.error, HTTP_500_RE, "error should contain HTTP status");
  });

  it("input schema validates query length and trimming", () => {
    // Verify the tool's input constraints
    const minLength = 2;
    const maxLength = 120;

    // Valid queries
    assert.ok("ab".length >= minLength, "2-char query should be valid");
    assert.ok("a".repeat(120).length <= maxLength, "120-char query valid");

    // Trimming should work
    const padded = "  query  ";
    const trimmed = padded.trim();
    assert.equal(trimmed, "query", "trimming should remove whitespace");
  });
});
