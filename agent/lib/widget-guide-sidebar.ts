// The widget guide's sidebar, read from Acquisity's apps/web/lib/sidebar/catalog.ts,
// its settings menu, read from apps/web/lib/new-design/settings-nav.ts, and the
// check that a "Get here:" path starting in the sidebar starts at a page it
// shows (ENG-20311, ENG-20575).

const GROUP_IDS_BLOCK = /SIDEBAR_GROUP_IDS = \{([\s\S]*?)\}/u;
const GROUPS_BLOCK = /SIDEBAR_CATALOG_GROUPS[^=]*= \[([\s\S]*?)\n\];/u;
const CRM_BLOCK = /CRM_V2_PAGE_SPECS[^=]*= \[([\s\S]*?)\n\];/u;
const PAGES_BLOCK = /SIDEBAR_CATALOG_PAGES[^=]*= \[([\s\S]*?)\n\];/u;
const GROUP_ID = /(\w+): '([^']+)'/gu;
const GROUP = /id: SIDEBAR_GROUP_IDS\.(\w+),\s*label: '([^']*)'/gu;
const CRM_LABEL = /label: '([^']+)'/u;
const CRM_ENTRY = /\n {2}\{/u;
const PAGE =
  /key: '([^']+)',\s*label: '([^']+)',[\s\S]*?defaultGroupId: SIDEBAR_GROUP_IDS\.(\w+)[\s\S]*?\n {2}\},/gu;
/** A page kept only for saved layouts, such as the old "CRM" item. */
const NEVER_SHOWN = /isVisible: \(\) => false/u;
const OPT_IN_BLOCK = /OPT_IN_FEATURES[^=]*= \[([\s\S]*?)\];/u;
const FEATURE_NAME = /FEATURES\.(\w+)/gu;
/**
 * The CRM's My Day and Conversations pages follow the opt-in MY_DAY feature
 * (apps/web/lib/crm/nav-access.ts: `conversations: myDay`).
 */
const CRM_OPT_IN = /crmV2Access\(ctx\)\.(?:myDay|conversations)/u;
const OPT_IN_NOTE = " (only where turned on)";

export interface GuideSidebar {
  /** Group headings, which a customer never clicks to reach a page. */
  headings: ReadonlySet<string>;
  /** One line per group, top to bottom. */
  lines: string;
  /** Every page label the sidebar can show. */
  pages: ReadonlySet<string>;
}

/**
 * The sidebar's groups and pages, in order, from the catalog source. A page
 * whose gate is an opt-in feature in apps/web/lib/features.ts is marked, since
 * a new workspace doesn't have it.
 */
export function parseGuideSidebar(
  source: string,
  features: string
): GuideSidebar {
  const optIn = new Set(
    [...(features.match(OPT_IN_BLOCK)?.[1] ?? "").matchAll(FEATURE_NAME)].map(
      (m) => m[1]
    )
  );
  const opensOnlyWhereOn = (entry: string) =>
    CRM_OPT_IN.test(entry) ||
    [...entry.matchAll(FEATURE_NAME)].some((m) => optIn.has(m[1]));
  const groupIds = Object.fromEntries(
    [...(source.match(GROUP_IDS_BLOCK)?.[1] ?? "").matchAll(GROUP_ID)].map(
      (m) => [m[1], m[2]]
    )
  );
  const groups = [
    ...(source.match(GROUPS_BLOCK)?.[1] ?? "").matchAll(GROUP),
  ].map((m) => ({ id: groupIds[m[1]], label: m[2], pages: [] as string[] }));
  const pages = new Set<string>();
  const crmGroup = groups.find((g) => g.id === "crm");
  const crmEntries = (source.match(CRM_BLOCK)?.[1] ?? "").split(CRM_ENTRY);
  for (const entry of crmEntries) {
    const label = CRM_LABEL.exec(entry)?.[1];
    if (label) {
      pages.add(label);
      crmGroup?.pages.push(
        `"${label}"${opensOnlyWhereOn(entry) ? OPT_IN_NOTE : ""}`
      );
    }
  }
  for (const m of (source.match(PAGES_BLOCK)?.[1] ?? "").matchAll(PAGE)) {
    if (!NEVER_SHOWN.test(m[0])) {
      pages.add(m[2]);
      groups
        .find((g) => g.id === groupIds[m[3]])
        ?.pages.push(`"${m[2]}"${opensOnlyWhereOn(m[0]) ? OPT_IN_NOTE : ""}`);
    }
  }
  // A reshaped catalog must fail here, not ship a guide without a sidebar.
  if (groups.length < 4 || pages.size < 15) {
    throw new Error(
      `sidebar parse found ${groups.length} groups, ${pages.size} pages`
    );
  }
  // Without the opt-in list every page would read as on for a new workspace.
  if (optIn.size === 0) {
    throw new Error("features parse found no OPT_IN_FEATURES");
  }
  return {
    headings: new Set(groups.map((g) => g.label).filter(Boolean)),
    lines: groups
      .filter((g) => g.pages.length)
      .map(
        (g) =>
          `- ${g.label ? `Under the "${g.label}" heading` : "At the top"}: ${g.pages.join(", ")}`
      )
      .join("\n"),
    pages,
  };
}

const IN_SIDEBAR = /\bsidebar\b|\bleft menu\b/iu;
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const headings = (sidebar: GuideSidebar) =>
  [...sidebar.headings].map(escapeRegExp).join("|");

/**
 * A path with a sidebar heading taken out where it is written as a click:
 * anywhere before " > ", or before ", then " at the start of the path or right
 * after "click" or "open". A heading after "under" or "in" says where a page
 * sits and stays.
 */
export const withoutHeadings = (sidebar: GuideSidebar, path: string) =>
  sidebar.headings.size
    ? path
        .replace(new RegExp(`"(?:${headings(sidebar)})" > `, "giu"), "")
        .replace(
          new RegExp(
            `(^|\\b(?:click|open) )"(?:${headings(sidebar)})", then `,
            "giu"
          ),
          "$1"
        )
    : path;

/**
 * False only for a path that says it starts in the sidebar and whose first
 * label, past any heading, is neither a page the sidebar shows nor one of the
 * entry points the guide describes: a retired label such as "Website Builder"
 * is refused even when the article's own words contain it ("AI Website
 * Builder").
 */
export const startsAtSidebarPage = (
  sidebar: GuideSidebar,
  entries: ReadonlySet<string>,
  path: string,
  labels: readonly string[]
) => {
  if (!IN_SIDEBAR.test(path)) {
    return true;
  }
  const first = labels.find((label) => !sidebar.headings.has(label));
  return (
    first !== undefined && (sidebar.pages.has(first) || entries.has(first))
  );
};

const QUOTED = /"([^"]+)"/gu;
const LABEL_EDGE = /^[\s,.;:]+|[\s,.;:]+$/gu;
/** The two entry points that have no label to quote. */
export const UNLABELLED = /\bworkspace name\b|\byour name\b/iu;
const LEFT_SIDEBAR = /\bsidebar\b/iu;

/** Each quoted label in a path, without edge punctuation, with where it starts. */
export const labelsIn = (path: string) =>
  [...path.matchAll(QUOTED)].map((m) => ({
    at: m.index,
    label: m[1].replace(LABEL_EDGE, ""),
  }));

/**
 * A path that says it starts in the left sidebar but opens at a label the
 * sidebar doesn't show, such as `click "Cold Email Agent", then
 * "Deliverability"`, starts again at its first label that is a sidebar page.
 * A path through the account or workspace menu, or through Settings, is a
 * different route and stays as it was, as does any path with no sidebar page
 * in it.
 */
export const fromFirstSidebarPage = (
  sidebar: GuideSidebar,
  entries: ReadonlySet<string>,
  path: string
) => {
  const labels = labelsIn(path);
  if (
    !LEFT_SIDEBAR.test(path) ||
    UNLABELLED.test(path) ||
    labels.some((l) => l.label === "Settings") ||
    startsAtSidebarPage(
      sidebar,
      entries,
      path,
      labels.map((l) => l.label)
    )
  ) {
    return path;
  }
  const page = labels.find((l) => sidebar.pages.has(l.label));
  return page === undefined
    ? path
    : `In the left sidebar, click ${path.slice(page.at)}`;
};

const ROUTE_START = "segment: '";
const ROUTE_SEGMENT = /^([^']+)'/u;
const ROUTE_GROUP = /group: '([^']+)'/u;
const ROUTE_LABEL = /label: '([^']+)'/u;
const ROUTE_ALTS = /altSegments: \[([^\]]*)\]/u;
const QUOTED_SEGMENT = /'([^']+)'/gu;
const FALLBACK = /FALLBACK_GROUP = '([^']+)'/u;
const MENU_ITEM =
  /label: '([^']+)',\s*href: `\$\{settingsBasePath\}\/([a-z0-9-]+)`/gu;
/** The kit leaves Calendly out of the menu (settings-menu-items.tsx). */
const NOT_IN_MENU = new Set(["calendly"]);
const LEGACY_BLOCK = /LEGACY_CRM_SETTINGS_TARGETS = \{([\s\S]*?)\n\}/u;
const LEGACY_KEY = /^ {2}'?([a-z0-9-]+)'?:/gmu;

/**
 * The settings menu as an owner sees it with every feature on, one line per
 * group, such as `"Workspace": "General", "Members"`. It follows the app's
 * `buildKitSettingsGroups` (settings-nav.ts): each grouped route row holds its
 * page, a page that can fill a row's slot (`altSegments`) is named with it, and
 * every other menu item (settings-menu-items.tsx) goes under the fallback
 * group with its own label. With the CRM on, the app drops the legacy pages
 * its CRM pages replace (LEGACY_CRM_SETTINGS_TARGETS in
 * crm-v2/settings-routes.ts), so those are left out. Which of them a
 * workspace with the CRM off sees depends on other gates, so the menu does not
 * list that case; each page's own article says how to reach it.
 */
export function parseSettingsMenu(
  nav: string,
  menu: string,
  crmRoutes: string
): string {
  const legacy = new Set(
    [...(crmRoutes.match(LEGACY_BLOCK)?.[1] ?? "").matchAll(LEGACY_KEY)].map(
      (m) => m[1]
    )
  );
  const routes = nav
    .split(ROUTE_START)
    .slice(1)
    .map((row) => ({
      alts: [...(ROUTE_ALTS.exec(row)?.[1] ?? "").matchAll(QUOTED_SEGMENT)].map(
        (m) => m[1]
      ),
      group: ROUTE_GROUP.exec(row)?.[1],
      label: ROUTE_LABEL.exec(row)?.[1],
      segment: ROUTE_SEGMENT.exec(row)?.[1] ?? "",
    }));
  const menuLabels = new Map<string, string>();
  for (const [, label, segment] of menu.matchAll(MENU_ITEM)) {
    if (!menuLabels.has(segment)) {
      menuLabels.set(segment, label);
    }
  }
  const labelOf = (segment: string) =>
    routes.find((r) => r.segment === segment)?.label ?? menuLabels.get(segment);
  const groups = new Map<string, string[]>();
  const add = (group: string, entry: string) =>
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  const claimed = new Set<string>();
  for (const route of routes) {
    if (!(route.group && route.label)) {
      continue;
    }
    claimed.add(route.segment);
    const alternatives = route.alts.flatMap((alt) => {
      claimed.add(alt);
      const label = labelOf(alt);
      return label ? [`"${label}"`] : [];
    });
    add(
      route.group,
      alternatives.length
        ? `"${route.label}" (or ${alternatives.join(", ")} where turned on)`
        : `"${route.label}"`
    );
  }
  const fallback = FALLBACK.exec(nav)?.[1] ?? "Workspace";
  for (const [segment, label] of menuLabels) {
    if (
      !(claimed.has(segment) || legacy.has(segment) || NOT_IN_MENU.has(segment))
    ) {
      add(fallback, `"${label}"`);
    }
  }
  const pages = [...groups.values()].flat().length;
  // A reshaped settings table must fail here, not ship a stale menu.
  if (groups.size < 4 || pages < 15) {
    throw new Error(
      `settings menu parse found ${groups.size} groups, ${pages} pages`
    );
  }
  return [...groups]
    .map(([group, labels]) => `"${group}": ${labels.join(", ")}`)
    .join("; ");
}

/**
 * Sidebar labels the app no longer shows, and the pages that took each one's
 * place, the first being where it led. Campaigns and Email accounts replace
 * "cold-email-agent" and AI Inbox replaces "ai-sdr-inbox" in catalog.ts
 * (`replaces`); Sites took over the "Website Builder" item, checked on
 * Acquisity main 2026-11-25 (ENG-20601).
 */
export const RETIRED_LABELS: ReadonlyMap<string, readonly string[]> = new Map([
  ["Cold Email Agent", ["Campaigns", "Email accounts", "Deliverability"]],
  ["AI SDR Inbox", ["AI Inbox"]],
  ["Website Builder", ["Sites"]],
]);
/** "Dashboard" is only Client users' name for Home (home-nav.ts). */
const RETIRED_FOR_TEAM: ReadonlyMap<string, readonly string[]> = new Map([
  ...RETIRED_LABELS,
  ["Dashboard", ["Home"]],
]);
/** The retired labels for an article: Client Portal articles keep "Dashboard". */
export const retiredFor = (slug: string) =>
  slug.startsWith("client-portal") ? RETIRED_LABELS : RETIRED_FOR_TEAM;

const MENTIONS_SETTINGS = /\bsettings\b/iu;
const CLAUSE_END = /[.;:](?:\s|$)/u;

/**
 * A path that opens at a retired sidebar label, such as `"Cold Email Agent" >
 * "Email Accounts"`, opens instead at the later label when it is one of the
 * pages that replaced the retired one (in the sidebar's own spelling), or at
 * the first of those pages. A later label is never promoted otherwise, so a
 * campaign's "Sequences" tab never becomes the CRM's "Sequences" page.
 * "Cold Email Agent" is also a Settings page and a section of a campaign's
 * Settings tab, so a path that names Settings before the retired label, or in
 * the same clause, stays as it was, unless it says it starts in the sidebar.
 */
export const withoutRetiredStart = (
  retired: ReadonlyMap<string, readonly string[]>,
  path: string
) => {
  const [first, ...rest] = labelsIn(path);
  const successors = first && retired.get(first.label);
  if (!successors?.length) {
    return path;
  }
  const before = path.slice(0, first.at);
  const [clause] = path.slice(first.at).split(CLAUSE_END);
  if (!LEFT_SIDEBAR.test(before) && MENTIONS_SETTINGS.test(before + clause)) {
    return path;
  }
  for (const later of rest) {
    const page = successors.find(
      (name) => name.toLowerCase() === later.label.toLowerCase()
    );
    if (page) {
      const end = path.indexOf('"', later.at + 1);
      return `${path.slice(0, first.at)}"${page}"${path.slice(end + 1)}`;
    }
  }
  return `${path.slice(0, first.at)}"${successors[0]}"${path.slice(path.indexOf('"', first.at + 1) + 1)}`;
};
