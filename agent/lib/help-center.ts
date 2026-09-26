import { z } from "zod";
import { type ProviderClient, requiredClient } from "./executor/operations.js";

/** Base for relative article links. The search backend is selected by the Executor binding. */
export const HELP_CENTER_BASE_URL =
  process.env.ACQUISITY_WEB_BASE_URL?.trim() || "https://app.acquisity.ai";

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
  /**
   * Likely repository path of the article source in `Acquisity/Acquisity`,
   * derived from the search hit id (which mirrors the public url path); the
   * search does not expose the real file, so a section page lives at
   * `<path without .mdx>/index.mdx` instead.
   */
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
  opts?: { linkBaseUrl?: string; client?: ProviderClient; signal?: AbortSignal }
): Promise<FindHelpArticleResult> {
  const baseUrl = opts?.linkBaseUrl ?? HELP_CENTER_BASE_URL;
  try {
    const client = requiredClient(opts?.client);
    const articleBase = new URL(baseUrl);
    const response = await client(
      { input: { query }, operation: "help.search" },
      {
        signal: opts?.signal
          ? AbortSignal.any([
              opts.signal,
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (response.status < 200 || response.status >= 300) {
      return {
        articles: [],
        error: `Help-center search failed: HTTP ${response.status}.`,
      };
    }
    const hits = z.array(hitSchema).parse(response.data);
    return {
      articles: hits
        .filter((hit) => hit.type === undefined || hit.type === "page")
        .slice(0, MAX_ARTICLES)
        .map((hit) => ({
          path: `apps/web/content/docs${hit.id.replace(DOCS_PREFIX, "")}.mdx`,
          title: stripMarks(hit.content),
          url: new URL(hit.url, articleBase).toString(),
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

const CONTENT_TIMEOUT_MS = 10_000;
const MAX_CONTENT_CHARS = 60_000;
const DOCS_SLUG = /^\/docs\/([A-Za-z0-9][A-Za-z0-9/_-]*)$/u;

/** The docs slug of a same-origin `/docs/<slug>` url, or null for anything else. */
export function helpArticleSlug(
  articleUrl: string,
  base: string = HELP_CENTER_BASE_URL
): string | null {
  try {
    const target = new URL(articleUrl, base);
    return target.host === new URL(base).host
      ? (DOCS_SLUG.exec(target.pathname)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

export const helpArticleContentSchema = z.object({
  content: z.string(),
  title: z.string().optional(),
  url: z.string(),
});

export type HelpArticleContent =
  | { content: string; title?: string; url: string }
  | { error: string; url: string };

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Fetch one help-center article's full markdown by the url the help search
 * returned, for a search -> read -> answer chat flow. The help center is public,
 * so this goes straight to the docs app rather than through the per-tenant
 * executor. Same-origin `/docs/<slug>` urls only; a failure returns `{ error }`
 * rather than throwing.
 */
export async function getHelpArticleContent(
  articleUrl: string,
  opts?: { baseUrl?: string; fetch?: FetchLike; signal?: AbortSignal }
): Promise<HelpArticleContent> {
  const base = opts?.baseUrl ?? HELP_CENTER_BASE_URL;
  const doFetch = (opts?.fetch ?? fetch) as unknown as FetchLike;
  const slug = helpArticleSlug(articleUrl, base);
  if (!slug) {
    return {
      error: "Not an Acquisity help-center article url.",
      url: articleUrl,
    };
  }
  try {
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(CONTENT_TIMEOUT_MS)])
      : AbortSignal.timeout(CONTENT_TIMEOUT_MS);
    const response = await doFetch(
      `${base}/api/docs-content?id=${encodeURIComponent(slug)}`,
      { headers: { accept: "application/json" }, signal }
    );
    if (response.status === 404) {
      return { error: "Article not found.", url: articleUrl };
    }
    if (!response.ok) {
      return {
        error: `Help-center content failed: HTTP ${response.status}.`,
        url: articleUrl,
      };
    }
    const data = helpArticleContentSchema.parse(await response.json());
    return {
      content: data.content.slice(0, MAX_CONTENT_CHARS),
      ...(data.title ? { title: data.title } : {}),
      url: articleUrl,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Help-center content failed.",
      url: articleUrl,
    };
  }
}
