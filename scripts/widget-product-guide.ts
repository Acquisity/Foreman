// Distill the Acquisity help center into the widget chat lane's product guide (ENG-14932).
//
//   pnpm widget:guide --repo <acquisity checkout> --ref <commit or branch>
//
// Reads apps/web/content/docs at <ref> with `git archive` (nothing in the
// checkout changes), has a gateway model rewrite each group of articles as
// compact guide sections that keep exact UI labels and the source slug, then
// writes agent/lib/widget-product-guide.ts. Rerun it whenever the docs ship.
// Each section opens with a "Get here:" line built from the article and the
// sidebar in apps/web/lib/sidebar/catalog.ts at the same ref, so a step's path
// sits in the section it cites.
// Needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.
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
import { gateway, generateText } from "ai";
import { assertGuideSections } from "../agent/lib/widget-guide-validation.js";

const MODEL = "anthropic/claude-sonnet-5";
/** The limits pass only collects what the distilled guide already says. */
const NAV_MODEL = "google/gemini-3.5-flash";
const DOCS = "apps/web/content/docs";
const CATALOG = "apps/web/lib/sidebar/catalog.ts";
const MDX = /\.mdx$/u;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/u;
const INDEX_PAGE = /(^|\/)index$/u;
const WHITESPACE = /\s+/u;
const SHORTENED = /^\.\.\.\//u;
const OUT = "agent/lib/widget-product-guide.ts";
const CALL_TIMEOUT_MS = 240_000;
const GIT_TIMEOUT_MS = 60_000;
const CONCURRENCY = 6;
/** Source characters per distill call. */
const BATCH_CHARS = 30_000;
/**
 * Words asked for per source character. The model writes about twice what it
 * is asked for, so 1.09M source characters come out near 45k tokens.
 */
const RATIO = 0.06 / 6;

/**
 * What the app shows depends on the workspace: most features can be switched
 * off per workspace and a few are opt-in (apps/web/lib/features.ts on Acquisity
 * main, checked 2026-10-08). These lines head the guide. Check the app before
 * changing them.
 */
const AVAILABILITY = [
  "Deleting a workspace is not available to anyone, owners included. {slug: workspace-settings/general}",
  'The AI Website Builder ("Sites" in the sidebar) is not on every workspace: new workspaces may not get it (ENG-14707). Customers who see "Sites" can use it as described below. {slug: ai-website-builder}',
  "Network Researcher, a Resources tool, is only on workspaces where it has been turned on, and the help center has no guide for it.",
  'Most features can be turned off for a workspace, and Client users see only the "Client Portal". When a customer does not see a feature in the sidebar, it may not be on for their workspace or their role.',
];

/**
 * Places the sidebar catalog does not list, checked in the app as an owner on
 * 2026-10-08 (ENG-14932 round 3) and in the shell's menu components. The
 * Personal pages carry no role check (settings-menu-items.tsx, isVisible: true),
 * and the AI Consultant line is the ai-consultant article's own scope (round 4).
 */
const ENTRY_POINTS = [
  '"Settings": click "Settings" at the bottom of the sidebar, or click the workspace name in the top-left corner, then "Settings". Its left menu groups pages under "Personal" and "Workspace".',
  'Settings, "Personal": "Profile", "Appearance", "Security", "Availability", "Email & Calendar", "Conferencing", "Access Tokens". These are each person\'s own settings: every role sees them and can change its own. "Workspace", as an owner sees it on a workspace with every feature on: "General", "Members", "Teams", "Roles & Permissions", "Workspace Snapshots", "Billing", "Payments", "Phone Numbers", "Voice", "Meeting Recordings", "Scheduling", "Cold Email Agent", "AI SDR Agent", "Sales Call Analyzer", "Your Niche & Offer", "Cold Email Blocklist", "Email Templates", "SMS Templates", "Sharing", "CRM Custom Fields", "Call & Meeting Outcomes", "Workflow Notifications", "Connected Apps & API Keys". A page shows only when the workspace has its feature and the role may use it.',
  'Workspace menu: click the workspace name in the top-left corner. It lists your workspaces, then "New Workspace", "Settings" and "Sign Out".',
  'Account menu: click your name at the bottom of the sidebar. It holds "Feedback" (support chat), "Resources", "Toggle theme", "Edit sidebar" and "Log out".',
  'Bottom of the sidebar, above "Settings": the "Credits" card with "Add credits", then "What\'s New" and "Help Center".',
  'AI Consultant: the "Chat" side of the Home/Chat toggle at the top of the left sidebar. It gives strategy advice (pricing, positioning, offer structure, niche selection, go-to-market), feedback on campaign results or copy you paste in, help troubleshooting performance, and market research in its Market Researcher mode; its Jacob AI mode helps with ad copy, campaign angles and offer messaging. It does not see your campaigns, CRM or calls. {slug: ai-consultant}',
];

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
  options: { ref: { type: "string" }, repo: { type: "string" } },
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

const GROUP_IDS_BLOCK = /SIDEBAR_GROUP_IDS = \{([\s\S]*?)\}/u;
const GROUPS_BLOCK = /SIDEBAR_CATALOG_GROUPS[^=]*= \[([\s\S]*?)\n\];/u;
const CRM_BLOCK = /CRM_V2_PAGE_SPECS[^=]*= \[([\s\S]*?)\n\];/u;
const PAGES_BLOCK = /SIDEBAR_CATALOG_PAGES[^=]*= \[([\s\S]*?)\n\];/u;
const GROUP_ID = /(\w+): '([^']+)'/gu;
const GROUP = /id: SIDEBAR_GROUP_IDS\.(\w+),\s*label: '([^']*)'/gu;
const CRM_PAGE = /label: '([^']+)'/gu;
const PAGE =
  /key: '([^']+)',\s*label: '([^']+)',[\s\S]*?defaultGroupId: SIDEBAR_GROUP_IDS\.(\w+)/gu;

/** The sidebar's groups and pages, in order, from the catalog at the same ref. */
function sidebar(source: string): string {
  const groupIds = Object.fromEntries(
    [...(source.match(GROUP_IDS_BLOCK)?.[1] ?? "").matchAll(GROUP_ID)].map(
      (m) => [m[1], m[2]]
    )
  );
  const groups = [
    ...(source.match(GROUPS_BLOCK)?.[1] ?? "").matchAll(GROUP),
  ].map((m) => ({ id: groupIds[m[1]], label: m[2], pages: [] as string[] }));
  const crmGroup = groups.find((g) => g.id === "crm");
  for (const m of (source.match(CRM_BLOCK)?.[1] ?? "").matchAll(CRM_PAGE)) {
    crmGroup?.pages.push(`"${m[1]}"`);
  }
  for (const m of (source.match(PAGES_BLOCK)?.[1] ?? "").matchAll(PAGE)) {
    const label =
      m[1] === "crm" ? '"CRM" (when the CRM group is not shown)' : `"${m[2]}"`;
    groups.find((g) => g.id === groupIds[m[3]])?.pages.push(label);
  }
  const pages = groups.flatMap((g) => g.pages).length;
  // A reshaped catalog must fail here, not ship a guide without a sidebar.
  if (groups.length < 4 || pages < 15) {
    throw new Error(
      `sidebar parse found ${groups.length} groups, ${pages} pages`
    );
  }
  return groups
    .filter((g) => g.pages.length)
    .map(
      (g) =>
        `- ${g.label ? `Under the "${g.label}" heading` : "At the top"}: ${g.pages.join(", ")}`
    )
    .join("\n");
}

const SIDEBAR = `Left sidebar, top to bottom, as a new workspace has it (group headings can be collapsed; a customer clicks the page, not the heading). A page shows only when the workspace has the feature and the role may use it; Client users see only "Client Portal". A customer can rearrange, hide and add pages with "Edit sidebar" in the account menu, so their sidebar may differ from this.
${sidebar(git("show", `${sha}:${CATALOG}`))}
${ENTRY_POINTS.map((line) => `- ${line}`).join("\n")}`;
console.log(SIDEBAR);

interface Article {
  section: string;
  slug: string;
  text: string;
  title: string;
}

const files = (path: string): string[] =>
  readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });

/** The help-center sidebar order, from each folder's meta.json. */
const order = (path: string): string[] => {
  const meta = join(path, "meta.json");
  const pages: string[] = existsSync(meta)
    ? (JSON.parse(readFileSync(meta, "utf8")).pages ?? [])
    : [];
  const names = [
    ...pages.filter((page) => !page.startsWith("---")),
    ...readdirSync(path)
      .map((name) => name.replace(MDX, ""))
      .filter((name) => name !== "meta.json"),
  ];
  return [...new Set(names)].flatMap((name) => {
    const full = join(path, name);
    if (existsSync(full) && statSync(full).isDirectory()) {
      return order(full);
    }
    return existsSync(`${full}.mdx`) ? [`${full}.mdx`] : [];
  });
};

/** MDX to plain markdown: components become text, navigation-only lists go. */
function stripMdx(source: string): { body: string; title: string } {
  const front = source.match(FRONTMATTER);
  const field = (name: string) =>
    front?.[1]
      .match(new RegExp(`^${name}:\\s*(.*)$`, "mu"))?.[1]
      ?.replace(/^["']|["']$/gu, "")
      .trim() ?? "";
  const body = source
    .slice(front?.[0].length ?? 0)
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
    title: field("title"),
  };
}

const articles: Article[] = order(root).map((path) => {
  const slug = relative(root, path).replace(MDX, "").replace(INDEX_PAGE, "");
  const { body, title } = stripMdx(scrub(readFileSync(path, "utf8")));
  return {
    section: slug.split("/")[0] || "index",
    slug: slug || "index",
    text: body,
    title: title || slug,
  };
});

const available = articles;

/** Consecutive articles of one section, up to BATCH_CHARS each. */
const batches: Article[][] = [];
for (const article of available) {
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

const DISTILL_PROMPT = `You turn Acquisity help-center articles into sections of a compact product guide. A support chatbot will answer customers from this guide alone, so it must keep every fact a customer could need and drop everything else.

Cover every article in the batch, in order. For each article write a heading line exactly like this, using the article's own title and slug as given:
### <title> {slug: <slug>}
then one line "Get here: <path>" giving how a customer reaches, inside the Acquisity app, the page or feature the article is about, then the article's facts as short lines or bullets. Every article gets this line, FAQ and overview pages included. The path is a path only: it stops at the page, and the steps go below it. It is never the help center's own sections or page titles ("Getting Started", "FAQ"). Write the path the way the article does when it gives one ("In the left sidebar, click "Cold Email Agent", then "Email Accounts""); when it gives none, build it from the sidebar and entry points below, which are the product's real navigation, starting from the sidebar page or entry point. Never put a sidebar heading in a path as something to click. Use only labels the article or the sidebar list gives, each in double quotes; never a slug, an article title or "see" another section. When neither places the feature, write exactly "Get here: not stated" with nothing after it. When an article adds nothing beyond another article in this batch, write only its heading and one line naming that slug.

Keep, in this order of importance:
1. Where things are: every navigation path, page, tab, menu, button, field, toggle and setting name. Copy each UI label exactly as the article writes it, with its capitalisation, in double quotes, and write paths as "Settings" > "Members". Never paraphrase or invent a label.
2. Steps: every click in order, compressed to one line each, with every warning or lasting consequence (data deleted for good, inboxes warming up for 14 days).
3. What each feature does, who can use it (roles such as Owner, Admin, Member, Client; plans; credits) and what it costs.
4. Common problems and their fixes.
5. Limits: what the product cannot do, does not support, or only does in some cases. State these plainly.
6. Numbers: prices, quotas, durations, limits.

Never name the outside services behind the product or developer web addresses; the docs already call them "the sending platform" and "the developer docs".

Drop marketing language, motivation, generic advice that is not about Acquisity, repeated explanations, and examples that add no fact. Never add a fact the articles do not state. Plain markdown, no tables, no em dashes. Stay under WORDS words for this batch in total: shorten wording and merge repeated facts rather than drop an article.

SIDEBAR_BLOCK`;

const LIMITS_PROMPT = `You are given a product guide for Acquisity, distilled from its help center, with each article's slug in braces. Write two short sections to sit at the top of the guide.

## Who can do what
Every role limit the guide states: which roles (Owner, Admin, Member, Client) can or cannot see or do an action or page, one line each with its slug in braces. Name the roles exactly as the guide does.

## What Acquisity cannot do
Every explicit limit and unsupported thing the guide states, one line each with its slug in braces.

Only what the guide states; never generalise one line to other features or roles. Start with the line "## Who can do what". Plain markdown, no tables, no em dashes. About 2,000 words in total.`;

let spent = 0;
const call = async (
  system: string,
  prompt: string,
  maxOutputTokens: number,
  model = MODEL
): Promise<string> => {
  // Each try gets its own deadline; the SDK's retries would share one.
  const attempt = (
    tries: number
  ): Promise<Awaited<ReturnType<typeof generateText>>> =>
    // A stalled response once ignored the abort, so the deadline is raced too.
    Promise.race([
      generateText({
        abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        maxOutputTokens,
        maxRetries: 0,
        model: gateway(model),
        prompt,
        // Gemini otherwise spends its whole output budget on hidden reasoning.
        providerOptions: {
          google: { thinkingConfig: { thinkingLevel: "minimal" } },
        },
        system,
      }),
      sleep(CALL_TIMEOUT_MS + 5000).then(() => {
        throw new Error("deadline");
      }),
    ]).catch((error: unknown) => {
      if (tries <= 1) {
        throw error;
      }
      console.log(`  retry after ${String(error).slice(0, 80)}`);
      return attempt(tries - 1);
    });
  const result = await attempt(3);
  const cost = Number(
    (result.providerMetadata?.gateway as { cost?: string } | undefined)?.cost ??
      0
  );
  spent += Number.isFinite(cost) ? cost : 0;
  console.log(
    `  out=${result.usage.outputTokens} reasoning=${result.usage.outputTokenDetails?.reasoningTokens ?? 0} words=${result.text.split(WHITESPACE).length}`
  );
  // A cut-off section silently drops every article after it.
  if (result.finishReason !== "stop") {
    throw new Error(`distill call ended with ${result.finishReason}`);
  }
  return result.text.trim();
};

const startedAt = Date.now();
const sections: string[] = new Array(batches.length);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const index = next;
      next += 1;
      const batch = batches[index];
      const chars = batch.reduce((sum, a) => sum + a.text.length, 0);
      const words = Math.max(60, Math.round(chars * RATIO));
      // biome-ignore lint/performance/noAwaitInLoops: a fixed pool of workers.
      sections[index] = await call(
        DISTILL_PROMPT.replace("WORDS", String(words)).replace(
          "SIDEBAR_BLOCK",
          SIDEBAR
        ),
        batch
          .map((a) => `ARTICLE title: ${a.title}\nslug: ${a.slug}\n\n${a.text}`)
          .join("\n\n=====\n\n"),
        32_000
      );
      console.log(`batch ${index + 1}/${batches.length} ${batch[0].slug}`);
    }
  })
);

/**
 * The model sometimes shortens a slug to ".../tail"; a tail that names exactly
 * one article is restored, and em dashes copied from the docs become commas.
 */
const slugs = available.map((a) => a.slug);
const linked = sections
  .join("\n\n")
  .replace(/\{slug: ([^}]+)\}/gu, (marker, slug: string) => {
    const tail = slug.trim().replace(SHORTENED, "/");
    const matches = slugs.filter((known) => `/${known}`.endsWith(tail));
    return slugs.includes(slug.trim()) || matches.length !== 1
      ? marker
      : `{slug: ${matches[0]}}`;
  });
/**
 * Each section keeps its own "Get here:" line when it is a usable path: it
 * quotes at least one label, every quoted label appears in the article or the
 * navigation above, and it names no help-center section. Otherwise the section
 * takes its nearest parent article's line, or none. A sidebar heading written
 * as a click is dropped from the path.
 */
const HEADING_ONLY = /"(Client Access|Outreach|Build|Go To Market)" > /gu;
const SECTION_HEAD = /^### .*\{slug: ([^}]+)\}$/u;
const GET_HERE = /^Get here: (.*)$/u;
const QUOTED = /"([^"]+)"/gu;
const LABEL_EDGE = /^[\s,.;:]+|[\s,.;:]+$/gu;
/** The two entry points that have no label to quote. */
const UNLABELLED = /\bworkspace name\b|\byour name at the bottom\b/iu;
const HELP_CENTER_PATH =
  /\bnot stated\b|\bFAQ\b|\bhelp center\b|"Getting Started"|\bsee (?:the )?\S+ section\b/iu;
const sourceText = new Map(available.map((a) => [a.slug, a.text]));
const usablePath = (slug: string, path: string): boolean => {
  const labels = [...path.matchAll(QUOTED)].map((m) =>
    m[1].replace(LABEL_EDGE, "")
  );
  const source = `${sourceText.get(slug) ?? ""}\n${SIDEBAR}`;
  return (
    (labels.length > 0 || UNLABELLED.test(path)) &&
    !HELP_CENTER_PATH.test(path) &&
    labels.every((label) => source.includes(label))
  );
};
const lines = linked.split("\n");
const paths = new Map<string, string>();
let current = "";
let dropped = 0;
for (const line of lines) {
  current = line.match(SECTION_HEAD)?.[1] ?? current;
  const path = line.match(GET_HERE)?.[1]?.replace(HEADING_ONLY, "");
  if (path && usablePath(current, path)) {
    paths.set(current, path);
  } else if (path) {
    dropped += 1;
    console.log(`  rejected ${current}: ${path}`);
  }
}
const inherited = (slug: string): string | undefined => {
  for (let parent = slug; parent.includes("/"); ) {
    parent = parent.slice(0, parent.lastIndexOf("/"));
    if (paths.has(parent)) {
      return paths.get(parent);
    }
  }
};
const body = lines
  .flatMap((line) => {
    if (GET_HERE.test(line)) {
      return [];
    }
    const slug = line.match(SECTION_HEAD)?.[1];
    if (!slug) {
      return [line];
    }
    const path = paths.get(slug) ?? inherited(slug);
    return path ? [line, `Get here: ${path}`] : [line];
  })
  .join("\n");
const headed = new Set(
  [...body.matchAll(/^#{2,4} .*\{slug: ([^}]+)\}/gmu)].map((m) => m[1])
);
assertGuideSections(body, slugs);
const limits = await call(LIMITS_PROMPT, body, 8000, NAV_MODEL);
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
// Agent-facing text carries no em dashes; the docs use them freely.
const plain = guide.replace(/\s*\u2014\s*/gu, ", ");
const vendors = plain.match(VENDOR_LEFT) ?? [];
if (vendors.length) {
  throw new Error(`vendor names left in the guide: ${vendors.join(", ")}`);
}

assertGuideSections(plain, slugs);

const escaped = plain
  .replace(/\\/gu, "\\\\")
  .replace(/`/gu, "\\`")
  .replace(/\$\{/gu, "\\${");
writeFileSync(
  OUT,
  `// Generated by scripts/widget-product-guide.ts from Acquisity ${sha.slice(0, 12)}. Do not edit by hand; rerun the script.\n\n/** Every distilled article's slug and title: the slugs the guide may cite. */\nexport const PRODUCT_GUIDE_ARTICLES: Record<string, string> = ${JSON.stringify(Object.fromEntries(available.map((a) => [a.slug, a.title])))};\n\nexport const PRODUCT_GUIDE = \`${escaped}\`;\n`
);
const tokens = Math.round(plain.length / 4);
const getHere = (body.match(/^Get here:/gmu) ?? []).length;
console.log(
  `get_here=${getHere} rejected=${dropped} headed=${slugs.filter((slug) => headed.has(slug)).length} articles=${articles.length} distilled=${available.length} batches=${batches.length} source_chars=${available.reduce((s, a) => s + a.text.length, 0)} guide_chars=${plain.length} ~tokens=${tokens} cost=$${spent.toFixed(2)} s=${Math.round((Date.now() - startedAt) / 1000)}`
);
