import { z } from "zod";

/** Help-center host; overridable so staging can be searched. */
export const HELP_CENTER_BASE_URL =
  process.env.ACQUISITY_WEB_BASE_URL ?? "https://app.acquisity.ai";

const MAX_ARTICLES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

/** One hit from fumadocs' `simple` search: `content` is the highlighted title. */
const hitSchema = z.looseObject({
  content: z.string(),
  id: z.string(),
  type: z.string().optional(),
  url: z.string(),
});

export const helpArticleSchema = z.object({
  /** Repository path of the article source in `Acquisity/Acquisity`. */
  path: z.string(),
  title: z.string(),
  url: z.string(),
});

export const findHelpArticleResultSchema = z.object({
  articles: z.array(helpArticleSchema),
  error: z.string().optional(),
});

export type FindHelpArticleResult = z.infer<typeof findHelpArticleResultSchema>;

const MARK_TAG = /<\/?mark>/gu;
const DOCS_PREFIX = /^\/docs/u;
const stripMarks = (text: string) => text.replace(MARK_TAG, "");

/**
 * One GET against the web app's public `/api/search` route
 * (`apps/web/app/api/search/route.ts`, fumadocs simple search over the
 * help-center MDX). It strips stop words itself. Page hits only, capped at
 * {@link MAX_ARTICLES}; a failed request returns `error` rather than throwing.
 */
export async function findHelpArticles(
  query: string,
  opts?: { baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal }
): Promise<FindHelpArticleResult> {
  const baseUrl = opts?.baseUrl ?? HELP_CENTER_BASE_URL;
  const fetchImpl = opts?.fetch ?? fetch;
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("query", query);

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: opts?.signal
        ? AbortSignal.any([
            opts.signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        articles: [],
        error: `Help-center search failed: HTTP ${response.status}.`,
      };
    }
    const hits = z.array(hitSchema).parse(await response.json());
    return {
      articles: hits
        .filter((hit) => hit.type === undefined || hit.type === "page")
        .slice(0, MAX_ARTICLES)
        .map((hit) => ({
          path: `apps/web/content/docs${hit.id.replace(DOCS_PREFIX, "")}.mdx`,
          title: stripMarks(hit.content),
          url: new URL(hit.url, baseUrl).toString(),
        })),
    };
  } catch (error) {
    return {
      articles: [],
      error:
        error instanceof Error ? error.message : "Help-center search failed.",
    };
  }
}
