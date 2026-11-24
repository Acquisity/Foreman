import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseGuideSidebar,
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
  page("cold-email-campaigns", "Campaigns", "coldEmail"),
  page("cold-email-ai-inbox", "AI Inbox", "coldEmail"),
  page("cold-email-email-accounts", "Email accounts", "coldEmail"),
  page("cold-email-deliverability-v2", "Deliverability", "coldEmail"),
  page("workflows", "Workflows", "build"),
  page("sites", "Sites", "build"),
  page("growth-plan-creator", "Growth Plan Creator", "build"),
  page("market-researcher", "Market Researcher", "build"),
  page("offer-creator", "Offer Creator", "build"),
].join("\n")}
];
`;

const sidebar = parseGuideSidebar(CATALOG);
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
      '- Under the "CRM" heading: "Deals", "People", "Companies", "Meetings", "Tasks", "Notes"',
      '- Under the "Cold Email" heading: "Campaigns", "AI Inbox", "Email accounts", "Deliverability"',
      '- Under the "Build" heading: "Workflows", "Sites", "Growth Plan Creator", "Market Researcher", "Offer Creator"',
    ].join("\n")
  );
  assert.ok(!sidebar.pages.has("CRM"));
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
});

test("a reshaped catalog fails instead of shipping a guide without a sidebar", () => {
  assert.throws(() => parseGuideSidebar("export const nothing = 1;"), {
    message: "sidebar parse found 0 groups, 0 pages",
  });
});
