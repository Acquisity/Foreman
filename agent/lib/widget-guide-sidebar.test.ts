import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromFirstSidebarPage,
  getHereFor,
  parseGuideSidebar,
  parseSettingsMenu,
  RETIRED_LABELS,
  retiredFor,
  startsAtSidebarPage,
  withoutHeadings,
  withoutRetiredStart,
  withRealGroups,
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
const FEATURES = `export const FEATURES = {
  AI_WEBSITE_CREATOR: 'ai_website_creator',
  WORKFLOWS: 'workflow_builder',
  MY_DAY: 'my_day',
  CRM_PAYMENTS: CRM_PAYMENTS_FEATURE,
} as const;

export const OPT_IN_FEATURES: FeatureName[] = [
  FEATURES.AI_WEBSITE_CREATOR,
  FEATURES.WORKFLOWS,
  FEATURES.MY_DAY,
  FEATURES.CRM_PAYMENTS,
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
  assert.deepEqual(
    [...sidebar.optInFeatures],
    // A literal key is read as written; an imported one is the lowercased name.
    ["ai_website_creator", "workflow_builder", "my_day", "crm_payments"]
  );
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
  assert.throws(
    () => parseGuideSidebar("export const nothing = 1;", FEATURES),
    {
      message: "sidebar parse found 0 groups, 0 pages",
    }
  );
  assert.throws(() => parseGuideSidebar(CATALOG, "export const nothing = 1;"), {
    message: "features parse found no OPT_IN_FEATURES",
  });
  assert.throws(
    () =>
      parseGuideSidebar(
        CATALOG,
        "export const OPT_IN_FEATURES: FeatureName[] = [\n  FEATURES.MY_DAY,\n];"
      ),
    { message: "features parse found no FEATURES block" }
  );
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
  menuItem("Workflow Notifications", "workflow-notifications"),
].join("\n");
/** Shaped like Acquisity's apps/web/lib/crm-v2/settings-routes.ts. */
const CRM_ROUTES = `export const LEGACY_CRM_SETTINGS_TARGETS = {
  'email-templates': { page: 'messaging', params: { channel: 'email' } },
  scheduling: { page: 'meetings', params: { tab: 'types' } },
} as const satisfies Record<string, LegacyCrmSettingsTarget>;`;

test("the settings menu follows the app's grouping, with alternate slots and its other pages", () => {
  assert.equal(
    parseSettingsMenu(SETTINGS_NAV, SETTINGS_MENU, CRM_ROUTES),
    '"Account": "Profile", "Notifications", "Appearance", "Security"; "Your calendar": "Email & Calendar", "Availability"; "Workspace": "General", "Members", "Billing", "Integrations", "Workflow Notifications"; "CRM": "Pipelines", "Records & fields", "Messaging", "Phone"; "Outreach": "Your Niche & Offer" (or "Acquisity Brain" where turned on), "Cold Email Agent"'
  );
  assert.throws(() => parseSettingsMenu("", "", ""), {
    message: "settings menu parse found 0 groups, 0 pages",
  });
});

test("a path that opens at a retired sidebar label opens at the real page", () => {
  const fixed = (path: string) =>
    withoutRetiredStart(retiredFor("workspace-settings/faq"), path);
  // Foreman#274's guide at 61b34ffa (ENG-20601).
  assert.equal(
    fixed('"Cold Email Agent" > "Deliverability", "Results" tab.'),
    '"Deliverability", "Results" tab.'
  );
  assert.equal(
    fixed('"Cold Email Agent" > "Email Accounts"'),
    '"Email accounts"'
  );
  assert.equal(
    fixed('"Cold Email Agent" > "Email Accounts".'),
    '"Email accounts".'
  );
  assert.equal(
    fixed('"Cold email agent" > "Email accounts"'),
    '"Email accounts"'
  );
  assert.equal(
    fixed('"Cold Email Agent" > campaign > "Leads"'),
    '"Campaigns" > campaign > "Leads"'
  );
  // A campaign tab named like a sidebar page elsewhere stays a campaign tab.
  assert.equal(
    fixed('"Cold Email Agent" > campaign > "Sequences" tab'),
    '"Campaigns" > campaign > "Sequences" tab'
  );
  assert.equal(
    fixed(
      'In the left sidebar, click "Cold Email Agent", open a campaign, then click the "Sequences" tab.'
    ),
    'In the left sidebar, click "Campaigns", open a campaign, then click the "Sequences" tab.'
  );
  // Settings named in a later sentence doesn't stop a sidebar repair.
  assert.equal(
    fixed(
      'In the left sidebar, click "Cold Email Agent", open a campaign, then click the "AI Agent" tab. Settings: "Settings" > "Cold Email Agent".'
    ),
    'In the left sidebar, click "Campaigns", open a campaign, then click the "AI Agent" tab. Settings: "Settings" > "Cold Email Agent".'
  );
  assert.equal(
    fixed('In the left sidebar, click "Dashboard".'),
    'In the left sidebar, click "Home".'
  );
  for (const path of [
    '"Settings" > "Cold Email Agent"',
    'In the left sidebar, click "Settings", then "Cold Email Agent"',
    '"Campaigns" > "New campaign"',
    'Settings > "Cold Email Agent"',
    '"Cold Email Agent" section of a campaign\'s "Settings" tab',
  ]) {
    assert.equal(fixed(path), path);
  }
  // Client users do have "Dashboard"; everyone else has "Home".
  const dashboard = 'In the left sidebar, click "Dashboard".';
  assert.equal(
    withoutRetiredStart(retiredFor("client-portal/faq"), dashboard),
    dashboard
  );
  assert.equal(retiredFor("client-portal"), RETIRED_LABELS);
});

test("a refused Get here path borrows no parent's, and a missing one does", () => {
  const paths = new Map([
    ["account-settings", '"Settings" > "Profile"'],
    ["account-settings/faq/notifications", '"Settings" > "Notifications"'],
  ]);
  // Foreman#274 at 77de3dc7: the course-login FAQ's sign-in path was refused.
  const refused = new Set(["account-settings/faq/course-login"]);
  assert.equal(
    getHereFor("account-settings/faq/course-login", paths, refused),
    undefined
  );
  assert.equal(
    getHereFor("account-settings/faq/course-login/old", paths, refused),
    undefined
  );
  assert.equal(
    getHereFor("account-settings/faq/password", paths, refused),
    '"Settings" > "Profile"'
  );
  assert.equal(
    getHereFor("account-settings/faq/notifications", paths, refused),
    '"Settings" > "Notifications"'
  );
});

test("a sidebar page named under the wrong heading is named under its real one", () => {
  // Foreman#274 at 87a8b4be: Campaigns moved from Outreach to Cold Email (ENG-20629).
  assert.equal(
    withRealGroups(
      sidebar,
      'In the left sidebar, click "Campaigns" (under "Outreach"), then the campaign'
    ),
    'In the left sidebar, click "Campaigns" (under "Cold Email"), then the campaign'
  );
  assert.equal(
    withRealGroups(sidebar, 'click "Campaigns" (under the "Outreach" group)'),
    'click "Campaigns" (under the "Cold Email" group)'
  );
  for (const path of [
    'click "Campaigns" (under "Cold Email")',
    'click "Profile" (under "Account")',
  ]) {
    assert.equal(withRealGroups(sidebar, path), path);
  }
  assert.equal(sidebar.groupOf.get("Deals"), "CRM");
});
