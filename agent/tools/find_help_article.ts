import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  findHelpArticleResultSchema,
  findHelpArticles,
} from "#lib/help-center.js";

export default defineTool({
  description:
    "Search Acquisity's public help center for the articles that state how a feature is supposed to work and what the customer is told to do. " +
    "Pass the feature and the action in the product's own words, for example 'connect Google inbox'. Returns up to 5 articles with the public url and the " +
    "repository path of the article source under apps/web/content/docs in Acquisity/Acquisity, which you can read after prepare_repository. " +
    "An empty list is a valid answer; error set means the search could not run.",
  execute({ query }, ctx) {
    return findHelpArticles(query, { signal: ctx.abortSignal });
  },
  inputSchema: z.object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .describe("Feature words and the customer's action, in product terms."),
  }),
  outputSchema: findHelpArticleResultSchema,
});
