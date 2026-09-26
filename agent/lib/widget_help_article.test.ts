import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { z } from "zod";
import type { FindHelpArticleResult } from "#lib/help-center.js";

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
    const toolModule = await import("../tools/widget_help_article.js");
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

  it("the tool's schemas trim and bound the query, and drop article paths", async () => {
    const { default: dynamic } = await import(
      "../tools/widget_help_article.js"
    );
    const tool = dynamic.events["step.started"]?.({}, {
      session: {
        auth: {
          initiator: {
            attributes: {},
            issuer: "foreman:widget-support",
          } as SessionAuthContext,
        },
      },
    } as never) as
      | { inputSchema: z.ZodType; outputSchema: z.ZodType }
      | null
      | undefined;
    assert.ok(tool);
    const parse = (query: string) => tool.inputSchema.safeParse({ query });
    assert.equal(parse("a").success, false);
    assert.equal(parse("ab").success, true);
    assert.equal(parse("a".repeat(120)).success, true);
    assert.equal(parse("a".repeat(121)).success, false);
    assert.deepEqual(parse("  email setup  ").data, { query: "email setup" });
    const found = await mockFindHelpArticles("email setup");
    const output = tool.outputSchema.parse(found) as {
      articles: Record<string, unknown>[];
    };
    assert.equal(output.articles.length, 2);
    for (const article of output.articles) {
      assert.equal("path" in article, false);
    }
    assert.deepEqual(
      tool.outputSchema.parse(await mockFindHelpArticles("error test")),
      { articles: [], error: "Help-center search failed: HTTP 500." }
    );
  });
});
