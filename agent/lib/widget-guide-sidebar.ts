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

/**
 * A path that says it starts in the sidebar but opens at a label the sidebar
 * doesn't show, such as `click "Cold Email Agent", then "Deliverability"`,
 * starts again at its first label that is a sidebar page. Any other path is
 * returned as it was.
 */
export const fromFirstSidebarPage = (
  sidebar: GuideSidebar,
  entries: ReadonlySet<string>,
  path: string,
  labels: readonly string[]
) => {
  if (startsAtSidebarPage(sidebar, entries, path, labels)) {
    return path;
  }
  const page = labels.find((label) => sidebar.pages.has(label));
  return page === undefined
    ? path
    : `In the left sidebar, click ${path.slice(path.indexOf(`"${page}"`))}`;
};

const SETTINGS_ROUTE = /group: '([^']+)',\s*label: '([^']+)'/gu;

/**
 * The settings menu's groups and pages, in order, from settings-nav.ts: one
 * line per group, such as `"Workspace": "General", "Members"`.
 */
export function parseSettingsMenu(source: string): string {
  const groups = new Map<string, string[]>();
  for (const [, group, label] of source.matchAll(SETTINGS_ROUTE)) {
    groups.set(group, [...(groups.get(group) ?? []), `"${label}"`]);
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
