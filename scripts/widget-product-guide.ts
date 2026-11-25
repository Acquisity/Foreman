// Distill the Acquisity help center into the widget chat lane's product guide (ENG-14932).
//
//   pnpm widget:guide --repo <acquisity checkout> --ref <commit or branch> [--full]
//
// Reads apps/web/content/docs at <ref> with `git archive` (nothing in the
// checkout changes), has a model rewrite each group of articles as
// compact guide sections that keep exact UI labels and the source slug, then
// writes agent/lib/widget-product-guide.ts. Rerun it whenever the docs ship.
// Each section opens with a "Get here:" line built from the article and the
// sidebar in apps/web/lib/sidebar/catalog.ts at the same ref, so a step's path
// sits in the section it cites.
// Each model call's output is stored in a separate JSON cache under a hash of its
// inputs (model, prompt, sidebar, articles), so a rerun calls the model only
// for the batches whose inputs changed; --full ignores those stored outputs.
// A run that changes nothing but the commit leaves the file as it was.
// Needs CLIPROXY_BASE_URL and CLIPROXY_API_KEY for the Claude calls
// (ENG-15082); since ENG-20607 every call, the limits pass included, is one.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { generateText } from "ai";
import { modelFor } from "../agent/lib/models.js";
import {
  assertGuideCallStopped,
  cachedGuideText,
  checkedGuideCall,
  countedGuideAttempt,
  type GuideLimits,
  guideArtifactsEqual,
  guideCallKey,
  guideLimitsCitations,
  joinGuideLimits,
  parseGuideCache,
  splitGuideLimits,
  splitGuideSections,
} from "../agent/lib/widget-guide-cache.js";
import {
  OPT_IN_NOTE,
  pageIsOptIn,
  spellOutOptInGates,
} from "../agent/lib/widget-guide-gates.js";
import {
  fromFirstSidebarPage,
  getHereFor,
  labelsIn,
  parseGuideSidebar,
  parseSettingsMenu,
  retiredFor,
  startsAtSidebarPage,
  UNLABELLED,
  withoutHeadings,
  withoutRetiredStart,
} from "../agent/lib/widget-guide-sidebar.js";
import { guideSourcePath } from "../agent/lib/widget-guide-source.js";
import {
  answerWords,
  assertGuideSections,
  assertOwnAnswers,
  frontmatterField,
  numberedSteps,
  plainDashes,
  shortAnswers,
} from "../agent/lib/widget-guide-validation.js";

const MODEL = "anthropic/claude-sonnet-5.5";
/**
 * The role and limit pass runs on the distill model: on Gemini Flash it
 * inverted exceptions and merged lines into false limits (ENG-20607).
 */
const LIMITS_MODEL = MODEL;
const LIMITS_MAX_TOKENS = 16_000;
const DOCS = "apps/web/content/docs";
const CATALOG = "apps/web/lib/sidebar/catalog.ts";
const FEATURES = "apps/web/lib/features.ts";
const SETTINGS_NAV = "apps/web/lib/new-design/settings-nav.ts";
const SETTINGS_MENU_ITEMS =
  "apps/web/components/organization/settings-menu-items.tsx";
const CRM_SETTINGS_ROUTES = "apps/web/lib/crm-v2/settings-routes.ts";
const MDX = /\.mdx$/u;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/u;
const INDEX_PAGE = /(^|\/)index$/u;
const WHITESPACE = /\s+/u;
const SHORTENED = /^\.\.\.\//u;
const OUT = "agent/lib/widget-product-guide.ts";
const CACHE_FILE = "scripts/widget-product-guide.cache.json";
const previousCache = readFileSync(CACHE_FILE, "utf8");
const productGuideCache = parseGuideCache(previousCache);
const CALL_TIMEOUT_MS = 240_000;
const GIT_TIMEOUT_MS = 60_000;
const CONCURRENCY = 6;
/** Distill tries per batch before the run fails, naming the batch. */
const BATCH_TRIES = 3;
/** Source characters per distill call. */
const BATCH_CHARS = 30_000;
/** Words asked for even the shortest article, so no answer is squeezed out. */
const MIN_ARTICLE_WORDS = 15;
const MIN_BATCH_WORDS = 60;
const WORDS_PER_STEP = 4;
const WORDS_PER_LABEL = 2;
const BOLD_LABEL = /\*\*[^*\n]{2,60}\*\*/gu;
/**
 * Words asked for per source character. The model writes about twice what it
 * is asked for, so 1.09M source characters come out near 45k tokens.
 */
const RATIO = 0.06 / 6;

/**
 * What a Client user opens, from client-portal/index.mdx ("What a client can
 * open") and home-nav.ts on Acquisity main, checked 2026-11-24.
 */
const CLIENT_PAGES =
  'Client users see "Client Portal", "Dashboard" (team members have "Home" instead), the CRM pages unless the CRM is off, and their own Personal settings. They see campaigns and the inbox only when their white-label partner has turned those on for clients, and even then not the setup, new campaign or email accounts pages. They never see the other tools, workspace settings, "Members" or "Billing".';

/**
 * What the app shows depends on the workspace: most features can be switched
 * off per workspace and a few are opt-in (apps/web/lib/features.ts on Acquisity
 * main, checked 2026-11-24: Resources is retired and no feature is called
 * Network Researcher). These lines head the guide. Check the app before
 * changing them.
 */
const AVAILABILITY = [
  "Deleting a workspace is not available to anyone, owners included. {slug: workspace-settings/general}",
  'The AI Website Builder ("Sites" in the sidebar) is not on every workspace: new workspaces may not get it (ENG-14707). Customers who see "Sites" can use it as described below. {slug: ai-website-builder}',
  "Most features can be turned off for a workspace. When a customer does not see a feature in the sidebar, it may not be on for their workspace or their role.",
  `${CLIENT_PAGES} {slug: client-portal}`,
];

/**
 * Places the sidebar catalog does not list, checked on Acquisity main on
 * 2026-11-24 in sidebar-account-menu.tsx and organization-menu-items.tsx
 * (OrganizationBottomMenuItems). The settings menu itself is read from
 * settings-nav.ts at the same ref (SETTINGS_MENU), and the AI Consultant line
 * is the ai-consultant article's own scope (ENG-14932 round 4).
 * Each line lists the labels a sidebar path may start from there (`starts`).
 */
const ENTRY_POINTS: { starts: string[]; text: string }[] = [
  {
    starts: ["Home", "Dashboard"],
    text: '"Home": the "Home" side of the Home/Chat toggle at the top of the left sidebar opens the workspace home page. Every role except Client has it; Client users have "Dashboard" in the sidebar instead.',
  },
  {
    starts: ["Settings"],
    text: '"Settings": click "Settings" at the bottom of the sidebar, or click the workspace name in the top-left corner, then "Settings". Its left menu groups pages as the next line lists them.',
  },
  {
    starts: [],
    text: 'Settings menu, by group, as an owner sees it on a workspace with every feature on: SETTINGS_MENU. "Account" and "Your calendar" hold each person\'s own settings, which they change for themselves. A page shows only when the workspace has its feature and the role may use it.',
  },
  {
    starts: [],
    text: 'Workspace menu: click the workspace name in the top-left corner. It lists your workspaces, then "New Workspace", "Settings" and "Sign Out".',
  },
  {
    starts: [],
    text: 'Account menu: click your name at the bottom of the sidebar. It holds "Feedback" (support chat, not for Client users), "Light theme" or "Dark theme", "Edit sidebar" (not for Client users) and "Log out".',
  },
  {
    starts: ["Credits", "Add credits", "What's New", "Help Center"],
    text: 'Bottom of the sidebar, top to bottom: the "What\'s New" card, "Help Center" (not on white-label partner workspaces), "Settings", then the "Credits" card with "Add credits" (not for Client users).',
  },
  {
    starts: ["Chat"],
    text: 'AI Consultant: the "Chat" side of the Home/Chat toggle at the top of the left sidebar. It gives strategy advice (pricing, positioning, offer structure, niche selection, go-to-market), feedback on campaign results or copy you paste in, help troubleshooting performance, and market research in its Market Researcher mode; its Jacob AI mode helps with ad copy, campaign angles and offer messaging. It does not see your campaigns, CRM or calls. {slug: ai-consultant}',
  },
];
const SIDEBAR_ENTRIES = new Set(ENTRY_POINTS.flatMap((entry) => entry.starts));

/**
 * Vendors behind the product and developer hosts; the chat speaks in
 * Acquisity's own terms, so they are replaced before the model sees the docs.
 */
const VENDORS: [RegExp, string][] = [
  [/\bInstantly(?:\.ai)?\b/gu, "the sending platform"],
  // "Resend" is also the invitation button; only the vendor's workflow step goes.
  [/\bResend email step\b/gu, "email step"],
  [/https?:\/\/(?:developer|api)\.acquisity\.ai\S*/gu, "the developer docs"],
  [/\b(?:developer|api)\.acquisity\.ai\b/gu, "the developer docs"],
];
const VENDOR_LEFT = /\bInstantly\b|(?:developer|api)\.acquisity\.ai/gu;
const scrub = (text: string) =>
  VENDORS.reduce((out, [pattern, word]) => out.replace(pattern, word), text);

const { values } = parseArgs({
  options: {
    full: { type: "boolean" },
    ref: { type: "string" },
    repo: { type: "string" },
  },
});
if (!(values.repo && values.ref)) {
  throw new Error("Usage: --repo <acquisity checkout> --ref <commit>");
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", values.repo as string, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  }).trim();

const sha = git("rev-parse", values.ref);
const dir = mkdtempSync(join(tmpdir(), "widget-guide-"));
execFileSync(
  "sh",
  [
    "-c",
    `git -C "$0" archive "$1" "$2" | tar -x -C "$3"`,
    values.repo,
    sha,
    DOCS,
    dir,
  ],
  { timeout: GIT_TIMEOUT_MS }
);
const root = join(dir, DOCS);

const GUIDE_SIDEBAR = parseGuideSidebar(
  git("show", `${sha}:${CATALOG}`),
  git("show", `${sha}:${FEATURES}`)
);
const SETTINGS_MENU = parseSettingsMenu(
  git("show", `${sha}:${SETTINGS_NAV}`),
  git("show", `${sha}:${SETTINGS_MENU_ITEMS}`),
  git("show", `${sha}:${CRM_SETTINGS_ROUTES}`)
);

const SIDEBAR = `Left sidebar, top to bottom (group headings can be collapsed; a customer clicks the page, not the heading). A page marked "(only where turned on)" is off until it is turned on for the workspace, so a new workspace doesn't have it. A page shows only when the workspace has the feature and the role may use it. ${CLIENT_PAGES} Only Client users have "Client Portal" in the sidebar; owners and admins can preview it at the workspace address followed by /client-portal, and invite a client from "Settings" > "Members". A customer can rearrange, hide and add pages with "Edit sidebar" in the account menu, so their sidebar may differ from this.
${GUIDE_SIDEBAR.lines}
${ENTRY_POINTS.map((entry) => `- ${entry.text.replace("SETTINGS_MENU", SETTINGS_MENU)}`).join("\n")}`;
console.log(SIDEBAR);

interface Article {
  /** The whole page is behind an opt-in feature (front matter `features:`). */
  optIn: boolean;
  section: string;
  slug: string;
  text: string;
  title: string;
}

/** The help-center sidebar order, from each folder's meta.json. */
const order = (path: string): string[] => {
  const directory = guideSourcePath(root, path);
  const entries = readdirSync(directory).map((name) => {
    guideSourcePath(root, join(directory, name));
    return name;
  });
  const meta = join(directory, "meta.json");
  const pages: string[] = existsSync(meta)
    ? (JSON.parse(readFileSync(meta, "utf8")).pages ?? [])
    : [];
  const names = [
    ...pages.filter((page) => !page.startsWith("---")),
    ...entries
      .map((name) => name.replace(MDX, ""))
      .filter((name) => name !== "meta.json"),
  ];
  return [...new Set(names)].flatMap((name) => {
    const full = join(directory, name);
    if (
      existsSync(full) &&
      statSync(guideSourcePath(root, full)).isDirectory()
    ) {
      return order(full);
    }
    return existsSync(`${full}.mdx`)
      ? [guideSourcePath(root, `${full}.mdx`)]
      : [];
  });
};

/**
 * MDX to plain markdown: components become text, navigation-only lists go. A
 * section behind an opt-in feature gate is spelled out (widget-guide-gates).
 */
function stripMdx(source: string): {
  body: string;
  optIn: boolean;
  title: string;
} {
  const front = source.match(FRONTMATTER);
  const field = (name: string) => frontmatterField(front?.[1] ?? "", name);
  const body = spellOutOptInGates(
    source.slice(front?.[0].length ?? 0),
    GUIDE_SIDEBAR.optInFeatures
  )
    .replace(/^(import|export) .*$/gmu, "")
    .replace(/<QuestionList[\s\S]*?<\/QuestionList>/gu, "")
    .replace(/<InlineSearchBar[^>]*\/>/gu, "")
    .replace(/<GlossaryList\s*\/>/gu, "")
    .replace(
      /<Card\s+title="([^"]*)"\s+href="([^"]*)"(?:\s+description="([^"]*)")?\s*\/>/gu,
      (_, title, href, summary) =>
        `- ${title} (${href})${summary ? `: ${summary}` : ""}`
    )
    .replace(/<Accordion\s+title="([^"]*)"[^>]*>/gu, "\n#### $1\n")
    .replace(/<Tab\s+value="([^"]*)"[^>]*>/gu, "\n$1:\n")
    .replace(/<Callout(?:\s+[^>]*)?>/gu, "\nNote: ")
    .replace(/<\/?[A-Z][A-Za-z.]*[^>]*>/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const description = field("description");
  return {
    body: description ? `${description}\n\n${body}` : body,
    optIn: pageIsOptIn(front?.[1] ?? "", GUIDE_SIDEBAR.optInFeatures),
    title: field("title"),
  };
}

const articles: Article[] = order(root).map((path) => {
  const slug = relative(root, path).replace(MDX, "").replace(INDEX_PAGE, "");
  const { body, optIn, title } = stripMdx(scrub(readFileSync(path, "utf8")));
  return {
    optIn,
    section: slug.split("/")[0] || "index",
    slug: slug || "index",
    text: body,
    title: title || slug,
  };
});

const available = articles;

const DISTILL_PROMPT = `You turn Acquisity help-center articles into sections of a compact product guide. A support chatbot will answer customers from this guide alone, so it must keep every fact a customer could need and drop everything else.

Cover every article in the batch, in order. For each article write a heading line exactly like this, using the article's own title and slug as given:
### <title> {slug: <slug>}
then one line "Get here: <path>" giving how a customer reaches, inside the Acquisity app, the page or feature the article is about, then the article's facts as short lines or bullets. Every article gets this line, FAQ and overview pages included. The path is a path only: it stops at the page, and the steps go below it. It is never the help center's own sections or page titles ("Getting Started", "FAQ"). Write the path the way the article does when it gives one ("In the left sidebar, click "Email accounts""); when it gives none, build it from the sidebar and entry points below, which are the product's real navigation, starting from the sidebar page or entry point. Never put a sidebar heading in a path as something to click. Use only labels the article or the sidebar list gives, each in double quotes; never a slug, an article title or "see" another section. When neither places the feature, write exactly "Get here: not stated" with nothing after it. Every article keeps its own answer: never write "Same as", "see" or another slug in place of a fact, even when another article says the same thing. A question article's first line answers its question.

Keep, in this order of importance:
1. Where things are: every navigation path, page, tab, menu, button, field, toggle and setting name. Copy each UI label exactly as the article writes it, with its capitalisation, in double quotes, and write paths as "Settings" > "Members". Never paraphrase or invent a label. On a page that lists settings, modes or options, keep each one by name with its choices and what it does, before any explanation.
2. Steps: every click in order, compressed to one line each, with every warning or lasting consequence (data deleted for good, inboxes warming up for 14 days). Keep every screen and choice the article names along the way, such as an offer or a second confirmation. Copy a step's path from the article; never build it from the sidebar list or another article.
3. What each feature does, who can use it (roles such as Owner, Admin, Member, Client; plans; credits) and what it costs.
4. Common problems and their fixes.
5. Limits: what the product cannot do, does not support, or only does in some cases. State these plainly.
6. Numbers: prices, quotas, durations, limits.

Never name the outside services behind the product or developer web addresses; the docs already call them "the sending platform" and "the developer docs".

Advice ("we recommend", "best", "avoid", "keep it short") stays advice: never turn it into a rule or a limit. A limit on one way of doing something (dragging on the board) is stated with that way, never as a limit on the action, which another way (a table action) may still allow. Never write that something can't be done unless the article says so.

Keep every condition a fact depends on ("only when", "only for", "unless", "sometimes") and the exact scope it applies to. Never widen a fact to cases the article does not name, never narrow it by adding "only", never turn "can sometimes" into "cannot", and copy every count exactly.

Drop marketing language, motivation, generic advice that is not about Acquisity, repeated explanations, and examples that add no fact. Never add a fact the articles do not state. Plain markdown, no tables, no em dashes. Each article's header gives its word allowance: write about that many words for it, and stay under WORDS words for this batch in total. Shorten wording and merge facts an article repeats rather than drop an article or its answer; never reduce an article with steps, conditions or limits to one line.

SIDEBAR_BLOCK`;

const LIMITS_PROMPT = `You are given a product guide for Acquisity, distilled from its help center, with each article's slug in braces. Write two short sections to sit at the top of the guide.

## Who can do what
Every role limit the guide states: which roles (Owner, Admin, Member, Client) can or cannot see or do an action or page, one line each with its slug in braces. Name the roles exactly as the guide does.

## What Acquisity cannot do
Every explicit limit and unsupported thing the guide states, one line each with its slug in braces.

Only what the guide states; never generalise one line to other features or roles. Each line restates one statement from one article: never combine two statements into one, and never turn an exception ("not for link payments") into a rule about everything else. Keep the condition and scope each line has in the guide ("only for CRM payments", "only where Acquisity bills directly", "except when no domain was provisioned", "support can sometimes"): a limit without its condition is wrong. Start with the line "## Who can do what". Plain markdown, no tables, no em dashes. About 2,000 words in total.`;

let spent = 0;
let unpriced = 0;
const stats = { attempts: 0, successfulCalls: 0 };
/** This run's outputs by key, in guide order: the next run's cache. */
const cache = new Map<string, string>();
const call = async (
  system: string,
  prompt: string,
  maxOutputTokens: number,
  model = MODEL
): Promise<{ fresh: boolean; key: string; text: string }> => {
  const key = guideCallKey(model, String(maxOutputTokens), system, prompt);
  const reused = cachedGuideText(productGuideCache, key, values.full ?? false);
  if (reused !== undefined) {
    return { fresh: false, key, text: reused };
  }
  const result = await countedGuideAttempt(stats, () =>
    Promise.race([
      generateText({
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        maxOutputTokens,
        maxRetries: 0,
        model: modelFor(model),
        prompt,
        system,
      }),
      sleep(CALL_TIMEOUT_MS + 5000).then(() => {
        throw new Error("deadline");
      }),
    ])
  );
  // Only gateway calls report a cost; a CLI Proxy call is counted as unpriced.
  const reported = (
    result.providerMetadata?.gateway as { cost?: string } | undefined
  )?.cost;
  if (reported === undefined) {
    unpriced += 1;
  } else {
    const cost = Number(reported);
    spent += Number.isFinite(cost) ? cost : 0;
  }
  console.log(
    `  out=${result.usage.outputTokens} reasoning=${result.usage.outputTokenDetails?.reasoningTokens ?? 0} words=${result.text.split(WHITESPACE).length}`
  );
  // A cut-off section silently drops every article after it.
  assertGuideCallStopped(result.finishReason);
  return { fresh: true, key, text: result.text.trim() };
};

/**
 * The model sometimes shortens a slug to ".../tail"; a tail that names exactly
 * one article is restored. Each batch must then head every one of its own
 * articles, or that batch is distilled again.
 */
const slugs = available.map((a) => a.slug);
const relink = (text: string) =>
  text.replace(/\{slug: ([^}]+)\}/gu, (marker, slug: string) => {
    const tail = slug.trim().replace(SHORTENED, "/");
    const matches = slugs.filter((known) => `/${known}`.endsWith(tail));
    return slugs.includes(slug.trim()) || matches.length !== 1
      ? marker
      : `{slug: ${matches[0]}}`;
  });

/**
 * Each article's section is stored under a key of its own inputs, so a rerun
 * distills only the articles that changed and leaves every other section as
 * it was, word for word.
 */
const articleKey = (a: Article) =>
  guideCallKey(MODEL, DISTILL_PROMPT, SIDEBAR, a.title, a.slug, a.text);
const distilled = new Map<string, string>();
const pending = available.filter((a) => {
  const text = cachedGuideText(
    productGuideCache,
    articleKey(a),
    values.full ?? false
  );
  if (text !== undefined) {
    distilled.set(a.slug, text);
  }
  return text === undefined;
});

/** Consecutive pending articles of one section, up to BATCH_CHARS each. */
const batches: Article[][] = [];
for (const article of pending) {
  const last = batches.at(-1);
  const size = (last ?? []).reduce((sum, a) => sum + a.text.length, 0);
  if (
    last &&
    last[0].section === article.section &&
    size + article.text.length <= BATCH_CHARS
  ) {
    last.push(article);
  } else {
    batches.push([article]);
  }
}

/**
 * Words asked for one article: its share of the ratio, never below a floor,
 * and enough for every numbered step and every bold UI label it names, so a
 * how-to or settings page keeps its steps and settings (ENG-20601).
 */
const allowance = (a: Article) =>
  Math.max(
    MIN_ARTICLE_WORDS,
    Math.round(a.text.length * RATIO),
    numberedSteps(a.text) * WORDS_PER_STEP,
    new Set(a.text.match(BOLD_LABEL)).size * WORDS_PER_LABEL
  );

const distillBatch = (batch: Article[], label: string) =>
  checkedGuideCall(
    label,
    BATCH_TRIES,
    () =>
      call(
        DISTILL_PROMPT.replace(
          "WORDS",
          String(
            Math.max(
              MIN_BATCH_WORDS,
              batch.reduce((sum, a) => sum + allowance(a), 0)
            )
          )
        ).replace("SIDEBAR_BLOCK", SIDEBAR),
        batch
          .map(
            (a) =>
              `ARTICLE title: ${a.title}\nslug: ${a.slug}\nwords: ${allowance(a)}\n\n${a.text}`
          )
          .join("\n\n=====\n\n"),
        32_000
      ),
    (text) => {
      const repaired = relink(text);
      assertGuideSections(
        repaired,
        batch.map((a) => a.slug)
      );
      assertOwnAnswers(repaired);
      return repaired;
    }
  );

const startedAt = Date.now();
const rewritten: string[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const index = next;
      next += 1;
      const batch = batches[index];
      // biome-ignore lint/performance/noAwaitInLoops: a fixed pool of workers.
      const out = await distillBatch(
        batch,
        `batch ${index + 1}/${batches.length} ${batch[0].slug}`
      );
      for (const [slug, section] of splitGuideSections(out.text)) {
        distilled.set(slug, section);
      }
      if (out.fresh) {
        rewritten.push(...batch.map((a) => a.slug));
        console.log(`batch ${index + 1}/${batches.length} ${batch[0].slug}`);
      }
    }
  })
);

/**
 * A long article a batch answered in a line or two is distilled once more on
 * its own (ENG-20575). Its section replaces the batch's only when it says
 * more. One still short is logged and kept, so a rerun with the same docs
 * leaves the guide as it was. One whose call fails keeps its batch section but
 * stays out of the cache, so the next run tries it again; it never stops this
 * run.
 */
const retryFailed = new Set<string>();
const shortened = pending.filter(
  (a) => shortAnswers(distilled.get(a.slug) ?? "", [a]).length > 0
);
for (const article of shortened) {
  const label = `alone ${article.slug}`;
  const before = distilled.get(article.slug) ?? "";
  try {
    // biome-ignore lint/performance/noAwaitInLoops: a few calls, one at a time.
    const out = await distillBatch([article], label);
    const section = splitGuideSections(out.text).get(article.slug);
    const words = (text: string) => answerWords(text).get(article.slug) ?? 0;
    if (section && words(section) > words(before)) {
      distilled.set(article.slug, section);
      rewritten.push(article.slug);
    }
  } catch (error) {
    retryFailed.add(article.slug);
    console.log(`  ${label} failed: ${String(error).slice(0, 160)}`);
  }
  if (shortAnswers(distilled.get(article.slug) ?? "", [article]).length) {
    console.log(`  still short ${article.slug}`);
  }
}

const linked = slugs.map((slug) => distilled.get(slug)).join("\n\n");
/**
 * Each section keeps its own "Get here:" line when it is a usable path: it
 * quotes at least one label, every quoted label appears in the article or the
 * navigation above, and it names no help-center section. A section that gave
 * no line takes its nearest parent article's; one whose line was refused, or
 * that sits below a refused parent, takes none (getHereFor). A path that starts in the
 * sidebar must start at a page the sidebar shows or one of its entry points,
 * so a retired label such as "Website Builder" is refused even when the
 * article's own words contain it ("AI Website Builder"). A sidebar heading
 * written as a click is dropped from the path.
 */
const SECTION_HEAD = /^### .*\{slug: ([^}]+)\}$/u;
const GET_HERE = /^Get here: (.*)$/u;
const HELP_CENTER_PATH =
  /\bnot stated\b|\bFAQ\b|\bhelp center\b|"Getting Started"|\bsee (?:the )?\S+ section\b/iu;
const sourceText = new Map(available.map((a) => [a.slug, a.text]));
const pageOptIn = new Set(available.filter((a) => a.optIn).map((a) => a.slug));
const usablePath = (slug: string, path: string): boolean => {
  const labels = labelsIn(path).map((l) => l.label);
  const source = `${sourceText.get(slug) ?? ""}\n${SIDEBAR}`;
  return (
    (labels.length > 0 || UNLABELLED.test(path)) &&
    !HELP_CENTER_PATH.test(path) &&
    labels.every((label) => source.includes(label)) &&
    (UNLABELLED.test(path) ||
      startsAtSidebarPage(GUIDE_SIDEBAR, SIDEBAR_ENTRIES, path, labels))
  );
};
const lines = linked.split("\n");
const paths = new Map<string, string>();
let current = "";
let dropped = 0;
/** Sections whose own path was refused: a parent's path would be a guess. */
const refused = new Set<string>();
for (const line of lines) {
  current = line.match(SECTION_HEAD)?.[1] ?? current;
  const found = line.match(GET_HERE)?.[1];
  const stripped =
    found &&
    withoutRetiredStart(
      retiredFor(current),
      withoutHeadings(GUIDE_SIDEBAR, found)
    );
  const path =
    stripped && fromFirstSidebarPage(GUIDE_SIDEBAR, SIDEBAR_ENTRIES, stripped);
  if (path && usablePath(current, path)) {
    paths.set(current, path);
  } else if (path) {
    dropped += 1;
    refused.add(current);
    console.log(`  rejected ${current}: ${path}`);
  }
}
const body = lines
  .flatMap((line) => {
    if (GET_HERE.test(line)) {
      return [];
    }
    const slug = line.match(SECTION_HEAD)?.[1];
    if (!slug) {
      return [line];
    }
    const path = getHereFor(slug, paths, refused);
    return [
      line,
      ...(path ? [`Get here: ${path}`] : []),
      ...(pageOptIn.has(slug) ? [`- ${OPT_IN_NOTE}`] : []),
    ];
  })
  .join("\n");
const headed = new Set(
  [...body.matchAll(/^#{2,4} .*\{slug: ([^}]+)\}/gmu)].map((m) => m[1])
);
assertGuideSections(body, slugs);
/**
 * The role and limit summary is stored per article as well, under that
 * article's finished section, so only the lines of changed sections are
 * written again. With nothing stored (a first run or --full) the whole guide
 * goes in one call.
 */
const finished = splitGuideSections(body);
const limitsKey = (slug: string) =>
  guideCallKey(LIMITS_MODEL, LIMITS_PROMPT, finished.get(slug) ?? "");
const summarised = new Map<string, GuideLimits>();
const stale = slugs.filter((slug) => {
  const text = cachedGuideText(
    productGuideCache,
    limitsKey(slug),
    values.full ?? false
  );
  if (text !== undefined) {
    summarised.set(slug, JSON.parse(text));
  }
  return text === undefined;
});
// A stored line that also cites a changed article is written again with it.
const changedSlugs = new Set(stale);
for (const [slug, summary] of summarised) {
  if (guideLimitsCitations(summary).some((cited) => changedSlugs.has(cited))) {
    summarised.delete(slug);
    stale.push(slug);
  }
}
stale.sort((a, b) => slugs.indexOf(a) - slugs.indexOf(b));
let limitsFresh = false;
if (stale.length) {
  const whole = stale.length === slugs.length;
  const limitsCall = await checkedGuideCall(
    "role and limit summary",
    BATCH_TRIES,
    () =>
      call(
        whole
          ? LIMITS_PROMPT
          : LIMITS_PROMPT.replace(
              "About 2,000 words in total.",
              "Write nothing for an article that states no role limit or unsupported thing."
            ),
        whole ? body : stale.map((slug) => finished.get(slug)).join("\n\n"),
        LIMITS_MAX_TOKENS,
        LIMITS_MODEL
      ),
    (text) => {
      if (!text.startsWith("## Who can do what")) {
        throw new Error('summary does not start with "## Who can do what"');
      }
      return text;
    }
  );
  limitsFresh = limitsCall.fresh;
  const { dropped: uncited, limits } = splitGuideLimits(limitsCall.text, stale);
  for (const line of uncited) {
    console.log(`  summary line cites no summarised article: ${line}`);
  }
  for (const [slug, summary] of limits) {
    summarised.set(slug, summary);
  }
}
const limits = joinGuideLimits(
  slugs.map((slug) => summarised.get(slug) ?? { cannot: [], who: [] })
);
for (const article of available) {
  if (!retryFailed.has(article.slug)) {
    cache.set(articleKey(article), distilled.get(article.slug) ?? "");
  }
}
for (const slug of slugs) {
  cache.set(limitsKey(slug), JSON.stringify(summarised.get(slug)));
}
const regenerated = [
  ...rewritten,
  ...(limitsFresh
    ? [`(role and limit summary, ${stale.length} articles)`]
    : []),
];
const availability = AVAILABILITY.map((line) => `- ${line}`).join("\n");
const guide = `# Acquisity product guide

Distilled from the Acquisity help center (apps/web/content/docs at ${sha.slice(0, 12)}). Each article heading carries its slug in braces; the article lives at https://app.acquisity.ai/docs/<slug>.

## What every workspace may not have
${availability}

## Navigation
${SIDEBAR}
Each article below opens with "Get here:", the path to the page it describes.

${limits}

## Articles

${body}
`;
rmSync(dir, { force: true, recursive: true });
const plain = plainDashes(guide);
const vendors = plain.match(VENDOR_LEFT) ?? [];
if (vendors.length) {
  throw new Error(`vendor names left in the guide: ${vendors.join(", ")}`);
}

assertGuideSections(plain, slugs);

const escaped = plain
  .replace(/\\/gu, "\\\\")
  .replace(/`/gu, "\\`")
  .replace(/\$\{/gu, "\\${");
const short = sha.slice(0, 12);
const generated = `// Generated by scripts/widget-product-guide.ts from Acquisity ${short}. Do not edit by hand; rerun the script.\n\n/** Every distilled article's slug and title: the slugs the guide may cite. */\nexport const PRODUCT_GUIDE_ARTICLES: Record<string, string> = ${JSON.stringify(Object.fromEntries(available.map((a) => [a.slug, a.title])))};\n\nexport const PRODUCT_GUIDE = \`${escaped}\`;\n`;
// Written as `biome check --write` leaves it (formatted, article keys sorted as
// lint requires), so validate passes and an unchanged rerun is byte-identical.
const formatted = execFileSync(
  "pnpm",
  ["exec", "biome", "check", "--write", `--stdin-file-path=${OUT}`],
  { encoding: "utf8", input: generated, maxBuffer: 64 * 1024 * 1024 }
);
const previous = readFileSync(OUT, "utf8");
const cacheJson = `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`;
if (
  guideArtifactsEqual(
    { cache: previousCache, guide: previous },
    { cache: cacheJson, guide: formatted }
  )
) {
  console.log("guide unchanged: only the commit differs, file left as it was");
} else {
  writeFileSync(OUT, formatted);
  writeFileSync(CACHE_FILE, cacheJson);
}
const tokens = Math.round(plain.length / 4);
const getHere = (body.match(/^Get here:/gmu) ?? []).length;
console.log(`regenerated=${regenerated.join(",") || "none"}`);
console.log(
  `successful_calls=${stats.successfulCalls} attempts=${stats.attempts} get_here=${getHere} rejected=${dropped} headed=${slugs.filter((slug) => headed.has(slug)).length} articles=${articles.length} distilled=${available.length} batches=${batches.length} source_chars=${available.reduce((s, a) => s + a.text.length, 0)} guide_chars=${plain.length} ~tokens=${tokens} reported_cost=$${spent.toFixed(2)} unpriced_calls=${unpriced} s=${Math.round((Date.now() - startedAt) / 1000)}`
);
