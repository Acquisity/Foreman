import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getHelpArticleContent } from "#lib/help-center.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Read the full text of one help-center article by its url (from a " +
    "widget_help_article result), so you can answer from its content and cite it. " +
    "Returns the article markdown, or error set when it could not be read.",
  execute({ url }, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    return getHelpArticleContent(url, { signal: ctx.abortSignal });
  },
  inputSchema: z.strictObject({
    url: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("The article url returned by widget_help_article."),
  }),
  outputSchema: z.union([
    z.object({
      content: z.string(),
      title: z.string().optional(),
      url: z.string(),
    }),
    z.object({ error: z.string(), url: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
