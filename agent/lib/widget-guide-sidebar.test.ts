import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromFirstSidebarPage,
  parseGuideSidebar,
  parseSettingsMenu,
  startsAtSidebarPage,
  withoutHeadings,
} from "./widget-guide-sidebar.js";

const page = (key: string, label: string, group: string, extra = "") => `  {
    key: '${key}',
    label: '${label}',
    icon: Icon,
    defaultGroupId: SIDEBAR_GROUP_IDS.${group},${extra}
    buildHref: (ctx) => ctx.basePath,
  },`;

/** Shaped like Acquisity's apps/web/lib/sidebar/catalog.ts. */
const CATALOG = `export const SIDEBAR_GROUP_IDS = {
  main: 'main',
  crm: 'crm',
  coldEmail: 'cold-email',
  build: 'build',
} as const;

export const SIDEBAR_CATALOG_GROUPS: readonly SidebarCatalogGroup[] = [
  { id: SIDEBAR_GROUP_IDS.main, label: '' },
  { id: SIDEBAR_GROUP_IDS.crm, label: 'CRM', tourId: 'tour-crm-group' },
  {
    id: SIDEBAR_GROUP_IDS.coldEmail,
    label: 'Cold Email',
  },
  { id: SIDEBAR_GROUP_IDS.build, label: 'Build', tourId: 'tour-build-group' },
];

const CRM_V2_PAGE_SPECS: readonly CrmPageSpec[] = [
  {
    key: 'crm-my-day',
    label: 'My Day',
    segment: 'my-day',
    isVisible: (ctx) => crmV2Access(ctx).myDay,
  },
  { key: 'crm-deals', label: 'Deals', segment: 'deals' },
  { key: 'crm-people', label: 'People', segment: 'people' },
  { key: 'crm-companies', label: 'Companies', segment: 'companies' },
  { key: 'crm-meetings', label: 'Meetings', segment: 'meetings' },
  { key: 'crm-tasks', label: 'Tasks', segment: 'tasks' },
  { key: 'crm-notes', label: 'Notes', segment: 'notes' },
];

export const SIDEBAR_CATALOG_PAGES: SidebarCatalogPage[] = [
${[
  page("crm", "CRM", "main", "\n    isVisible: () => false,"),
  `  {
    key: 'old-inbox',
    label: 'Old Inbox',
    isVisible: () => false,
    icon: Icon,
    defaultGroupId: SIDEBAR_GROUP_IDS.coldEmail,
  },`,
  page("cold-email-campaigns", "Campaigns", "coldEmail"),
  page("cold-email-ai-inbox", "AI Inbox", "coldEmail"),
  page("cold-email-email-accounts", "Email accounts", "coldEmail"),
  page("cold-email-deliverability-v2", "Deliverability", "coldEmail"),
  page(
    "workflows",
    "Workflows",
    "build",
    "\n    isVisible: (ctx) => feature(ctx, FEATURES.WORKFLOWS) && notClient(ctx),"
  ),
  page("sites", "Sites", "build"),
  page("growth-plan-creator", "Growth Plan Creator", "build"),
  page("market-researcher", "Market Researcher", "build"),
  page("offer-creator", "Offer Creator", "build"),
].join("\n")}
];
`;

/** Shaped like Acquisity's apps/web/lib/features.ts. */
const FEATURES = `export const OPT_IN_FEATURES: FeatureName[] = [
  FEATURES.AI_WEBSITE_CREATOR,
  FEATURES.WORKFLOWS,
  FEATURES.MY_DAY,
];`;

const sidebar = parseGuideSidebar(CATALOG, FEATURES);
const ENTRIES = new Set(["Home", "Dashboard", "Settings"]);
const QUOTED = /"([^"]+)"/gu;
const check = (path: string) => {
  const stripped = withoutHeadings(sidebar, path);
  return startsAtSidebarPage(
    sidebar,
    ENTRIES,
    stripped,
    [...stripped.matchAll(QUOTED)].map((m) => m[1])
  );
};

test("the guide's sidebar lists no page the app never shows", () => {
  assert.equal(
    sidebar.lines,
    [
      '- Under the "CRM" heading: "My Day" (only where turned on), "Deals", "People", "Companies", "Meetings", "Tasks", "Notes"',
      '- Under the "Cold Email" heading: "Campaigns", "AI Inbox", "Email accounts", "Deliverability"',
      '- Under the "Build" heading: "Workflows" (only where turned on), "Sites", "Growth Plan Creator", "Market Researcher", "Offer Creator"',
    ].join("\n")
  );
  assert.ok(!sidebar.pages.has("CRM"));
  assert.ok(!sidebar.pages.has("Old Inbox"));
  assert.deepEqual([...sidebar.headings], ["CRM", "Cold Email", "Build"]);
});

test("a sidebar path must start at a page the sidebar shows", () => {
  assert.equal(check('In the left sidebar, click "Website Builder"'), false);
  assert.equal(
    check(
      'In the left sidebar, click "Cold Email Agent", then "Email Accounts"'
    ),
    false
  );
  assert.equal(check('In the left sidebar, click "CRM"'), false);
  assert.equal(
    check('In the left sidebar, click "Sites", then "Websites"'),
    true
  );
  assert.equal(check('In the left sidebar, click "CRM", then "Deals"'), true);
  assert.equal(
    check('In the left menu, open "Cold Email" and click "Email accounts"'),
    true
  );
  assert.equal(check('Click "Settings" at the bottom of the sidebar'), true);
  assert.equal(check('"Settings" > "Billing"'), true);
  assert.equal(check('In the left menu, click "Dashboard"'), true);
});

test("a heading written as a click is taken out of the path", () => {
  assert.equal(
    withoutHeadings(sidebar, '"Cold Email" > "Email accounts"'),
    '"Email accounts"'
  );
  assert.equal(
    withoutHeadings(sidebar, 'In the left sidebar, click "CRM", then "Deals"'),
    'In the left sidebar, click "Deals"'
  );
  const placed =
    'Click "Email accounts" under "Cold Email", then "Domain forwarding"';
  assert.equal(withoutHeadings(sidebar, placed), placed);
  assert.equal(
    withoutHeadings(sidebar, 'Go to "Build" > "Sites"'),
    'Go to "Sites"'
  );
});

test("a reshaped catalog fails instead of shipping a guide without a sidebar", () => {
  assert.throws(() => parseGuideSidebar("export const nothing = 1;", ""), {
    message: "sidebar parse found 0 groups, 0 pages",
  });
});

test("a sidebar path that opens at a retired label starts again at its first sidebar page", () => {
  const repaired = (path: string) =>
    fromFirstSidebarPage(sidebar, ENTRIES, path);
  // Foreman#274's guide at 30052833 (ENG-20575).
  assert.equal(
    repaired(
      'In the left sidebar, click "Cold Email Agent", then "Deliverability" > "Results".'
    ),
    'In the left sidebar, click "Deliverability" > "Results".'
  );
  assert.equal(
    repaired(
      'In the left sidebar, click "Cold Email Agent", then "Deliverability."'
    ),
    'In the left sidebar, click "Deliverability."'
  );
  // Other routes, and paths with no sidebar page, stay as they were.
  for (const path of [
    'In the left sidebar, click "Website Builder"',
    '"Settings" > "Billing"',
    'In the left sidebar, click your name, then "Edit sidebar", and turn on "Workflows"',
    'In the sidebar, click "Settings", then "Cold Email Agent" and "Email accounts"',
    'In the Settings left menu, click "Cold Email Agent", then "Email accounts"',
  ]) {
    assert.equal(repaired(path), path);
  }
});

/** One route row shaped like Acquisity's apps/web/lib/new-design/settings-nav.ts. */
const route = (segment: string, group?: string, label?: string, extra = "") =>
  `  {\n    segment: '${segment}',${group ? `\n    group: '${group}',` : ""}${label ? `\n    label: '${label}',` : ""}${extra}\n  },`;
const SETTINGS_NAV = [
  "const FALLBACK_GROUP = 'Workspace';",
  ...[
    ["Account", ["Profile", "Notifications", "Appearance", "Security"]],
    ["Your calendar", ["Email & Calendar", "Availability"]],
    ["Workspace", ["General", "Members", "Billing", "Integrations"]],
    ["CRM", ["Pipelines", "Records & fields", "Messaging", "Phone"]],
  ].flatMap(([group, labels]) =>
    (labels as string[]).map((label) =>
      route(label.toLowerCase(), group as string, label)
    )
  ),
  route(
    "niche-offer",
    "Outreach",
    "Your Niche & Offer",
    "\n    altSegments: ['acquisity-brain'],"
  ),
  route("cold-email-agent", "Outreach", "Cold Email Agent"),
  "  { segment: 'calendly', label: 'Calendly', wide: true },",
  route("acquisity-brain", undefined, "Acquisity Brain"),
  "  { segment: 'scheduling', tool: ACTIVATION_TOOLS.SettingsScheduling },",
].join("\n");
/** Production items shaped like settings-menu-items.tsx. */
const menuItem = (label: string, segment: string) =>
  `      {\n        label: '${label}',\n        href: \`\${settingsBasePath}/${segment}\`,\n      },`;
const SETTINGS_MENU = [
  menuItem("Members", "members"),
  menuItem("Scheduling", "scheduling"),
  menuItem("Calendly", "calendly"),
  menuItem("Email Templates", "email-templates"),
].join("\n");

test("the settings menu follows the app's grouping, with alternate slots and its other pages", () => {
  assert.equal(
    parseSettingsMenu(SETTINGS_NAV, SETTINGS_MENU),
    '"Account": "Profile", "Notifications", "Appearance", "Security"; "Your calendar": "Email & Calendar", "Availability"; "Workspace": "General", "Members", "Billing", "Integrations", "Scheduling", "Email Templates"; "CRM": "Pipelines", "Records & fields", "Messaging", "Phone"; "Outreach": "Your Niche & Offer" (or "Acquisity Brain" where turned on), "Cold Email Agent"'
  );
  assert.throws(() => parseSettingsMenu("", ""), {
    message: "settings menu parse found 0 groups, 0 pages",
  });
});
