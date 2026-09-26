import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { findHelpArticles, helpArticleSchema } from "#lib/help-center.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

const widgetArticleSchema = helpArticleSchema.omit({ path: true });

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Search the public help center for articles relevant to the customer's inquiry. " +
    "Returns up to 5 articles with title and url only, no excerpt; read one with widget_read_help_article before answering from it. " +
    "An empty result is valid; error set means the search could not run.",
  execute({ query }, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    return findHelpArticles(query, {
      client: executorClient(ctx),
      signal: ctx.abortSignal,
    });
  },
  inputSchema: z.strictObject({
    query: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .describe("Customer inquiry or feature name to search for."),
  }),
  outputSchema: z.object({
    articles: z.array(widgetArticleSchema),
    error: z.string().optional(),
  }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
