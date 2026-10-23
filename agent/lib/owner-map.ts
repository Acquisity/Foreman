export const SUPPORT_OWNER = "Aaron Fraga";
export const FALLBACK_OWNER = "James Keeble";

export const BUG_LABEL = "Bug";
export const FEATURE_REQUEST_LABEL = "Feature Request";
export const APPROVED_LABEL = "Approved";
export const NEEDS_APPROVAL_LABEL = "Needs approval";

export const AREA_KEYS = [
  "ai_sdr",
  "cold_email",
  "billing",
  "inboxes_domains",
  "crm_records",
  "crm_work",
  "crm_phone",
  "crm_conversations",
  "core_platform",
  "devops",
  "acquisity_agent",
  "workflows",
  "widget",
  "refunds",
  "other",
] as const;

export type AreaKey = (typeof AREA_KEYS)[number];

export type Lane = "developer" | "support";

export interface Area {
  description: string;
  label: string;
  lane: Lane;
  owner: string;
  paths: readonly string[];
  projects: readonly string[];
}

export const AREAS: Readonly<Record<AreaKey, Area>> = {
  acquisity_agent: {
    description: "the Acquisity Agent and AI Consultant product",
    label: "Area: Acquisity Agent",
    lane: "developer",
    owner: "James Keeble",
    paths: [],
    projects: ["Acquisity Agent"],
  },
  ai_sdr: {
    description:
      "the AI SDR: replies, escalation, classification, scheduling and its inbox",
    label: "Area: AI SDR",
    lane: "developer",
    owner: "Koppany Kondricz",
    paths: [],
    projects: [
      "AI SDR Core",
      "AI SDR Escalation & Classification",
      "AI SDR Inbox & UI",
      "AI SDR Scheduling",
      "AI SDR v1",
    ],
  },
  billing: {
    description:
      "subscriptions, credits, checkout and billing providers (a bug in billing code, not a refund request)",
    label: "Area: Billing",
    lane: "developer",
    owner: "Anthony Adewale",
    paths: [],
    projects: ["Billing"],
  },
  cold_email: {
    description:
      "cold email campaigns, the cold email agent, leads, sending and sending infrastructure",
    label: "Area: Cold Email",
    lane: "developer",
    owner: "Anthony Adewale",
    paths: [],
    projects: [
      "Cold Email Agent",
      "Cold Email Core",
      "Cold Email Infra",
      "Cold Email Leads",
    ],
  },
  core_platform: {
    description:
      "workspaces, accounts, authentication, permissions and shared platform code",
    label: "Area: Core Platform",
    lane: "developer",
    owner: "Anuj Bhatt",
    paths: [],
    projects: ["Core Platform"],
  },
  crm_conversations: {
    description:
      "CRM conversations and notifications: message threads, the inbox and notification cards",
    label: "Area: CRM Conversations",
    lane: "developer",
    owner: "Elis Bushaj",
    paths: [
      "components/notifications/",
      "lib/notifications/",
      "components/crm-v2/conversations/",
      "components/crm/conversations/",
      "trpc/routers/conversations",
      "trpc/routers/notification",
    ],
    projects: [],
  },
  crm_phone: {
    description: "CRM phone calling, dialler, texting and caller identity",
    label: "Area: CRM Phone",
    lane: "developer",
    owner: "Ebubeker Rexha",
    paths: [
      "components/crm-v2/phone/",
      "components/crm/call/",
      "components/crm/power-dialer/",
      "components/crm/sms-templates/",
      "components/crm/scheduled-messages/",
      "components/dialer",
      "components/phone-dialer",
      "components/caller-verification",
      "components/a2p-registration",
      "lib/dialer",
      "lib/phone-dialer",
      "lib/call-forwarding",
      "trpc/routers/sms",
      "trpc/routers/phone",
      "trpc/routers/dialer",
      "trpc/routers/call",
      "trpc/routers/voice",
      "trpc/routers/caller-verification",
    ],
    projects: ["CRM Phone Calling & Texting"],
  },
  crm_records: {
    description:
      "CRM records, pipelines, deals, views, filters, lists and imports",
    label: "Area: CRM Records",
    lane: "developer",
    owner: "Ebubeker Rexha",
    paths: [
      "components/crm-v2/",
      "components/crm/",
      "lib/crm-v2/",
      "lib/crm/",
      "trpc/routers/crm",
    ],
    projects: ["CRM"],
  },
  crm_work: {
    description:
      "CRM tasks, sequences, my day, calendar scheduling, meetings and payments",
    label: "Area: CRM Work",
    lane: "developer",
    owner: "Ebubeker Rexha",
    paths: [
      "components/crm-v2/tasks/",
      "components/crm-v2/sequences/",
      "components/crm-v2/my-day/",
      "components/crm-v2/floor-command/",
      "components/crm-v2/meetings/",
      "components/crm-v2/payments/",
      "components/crm/tasks/",
      "components/crm/my-day/",
      "components/crm/email-templates/",
      "components/crm/payments/",
      "components/calendar/",
      "components/calendly/",
      "components/scheduling/",
      "components/sales-calls/",
      "lib/crm-payments/",
      "lib/recall-ai/",
      "lib/sales-calls/",
    ],
    projects: ["CRM Calendar Scheduling"],
  },
  devops: {
    description: "deployment, CI, hosting, databases and infrastructure",
    label: "Area: Dev Ops",
    lane: "developer",
    owner: "James Keeble",
    paths: [],
    projects: ["Dev Ops"],
  },
  inboxes_domains: {
    description:
      "buying, provisioning and managing sending domains and inboxes",
    label: "Area: Inboxes and Domains",
    lane: "developer",
    owner: "Anthony Adewale",
    paths: [],
    projects: ["Domains & Inboxes"],
  },
  other: {
    description:
      "anything that fits no other area, including the website builder, onboarding and the public API",
    label: "Area: Other",
    lane: "developer",
    owner: "James Keeble",
    paths: [],
    projects: [],
  },
  refunds: {
    description:
      "refunds, credits and concessions that the support team grants to a customer",
    label: "Area: Refunds",
    lane: "support",
    owner: "Aaron Fraga",
    paths: [],
    projects: ["Support"],
  },
  widget: {
    description: "the in-app support chat widget",
    label: "Area: Support Widget",
    lane: "support",
    owner: "Aaron Fraga",
    paths: [],
    projects: ["Acquisity Chat Widget"],
  },
  workflows: {
    description: "the workflow builder and workflow runs",
    label: "Area: Workflows",
    lane: "developer",
    owner: "James Keeble",
    paths: [],
    projects: ["Workflows"],
  },
};

export const FALLBACK_AREA: AreaKey = "other";

const CRM_PATH_ORDER: readonly AreaKey[] = [
  "crm_conversations",
  "crm_phone",
  "crm_work",
  "crm_records",
];

const normalize = (value: string): string => value.trim().toLowerCase();

const areaEntries = AREA_KEYS.map((key) => [key, AREAS[key]] as const);

const OWNER_BY_NAME = new Map<string, { lane: Lane; name: string }>();
for (const [, area] of areaEntries) {
  const known = OWNER_BY_NAME.get(normalize(area.owner));
  OWNER_BY_NAME.set(normalize(area.owner), {
    lane: known?.lane === "developer" ? "developer" : area.lane,
    name: area.owner,
  });
}
OWNER_BY_NAME.set(normalize(FALLBACK_OWNER), {
  lane: "developer",
  name: FALLBACK_OWNER,
});

export const ownerNames = (): string[] =>
  [...OWNER_BY_NAME.values()]
    .map((owner) => owner.name)
    .sort((a, b) => a.localeCompare(b));

export const mappedOwner = (
  name: string
): { lane: Lane; name: string } | null =>
  OWNER_BY_NAME.get(normalize(name)) ?? null;

export const isDeveloperOwner = (name: string): boolean =>
  mappedOwner(name)?.lane === "developer";

export const areaForProject = (project: string): AreaKey | null => {
  const wanted = normalize(project);
  return (
    areaEntries.find(([, area]) =>
      area.projects.some((name) => normalize(name) === wanted)
    )?.[0] ?? null
  );
};

const SPECIFIC_CRM_ORDER = CRM_PATH_ORDER.filter(
  (key) => key !== "crm_records"
);

const pathMatches = (
  order: readonly AreaKey[],
  file: string
): AreaKey | null => {
  const path = file.replaceAll("\\", "/");
  return (
    order.find((key) =>
      AREAS[key].paths.some((prefix) => path.includes(prefix))
    ) ?? null
  );
};

export const areaForPath = (file: string): AreaKey | null =>
  pathMatches(CRM_PATH_ORDER, file);

export const specificAreaForPath = (file: string): AreaKey | null =>
  pathMatches(SPECIFIC_CRM_ORDER, file);

export const isCrmArea = (key: AreaKey): boolean => key.startsWith("crm_");

export const isAreaKey = (value: string): value is AreaKey =>
  (AREA_KEYS as readonly string[]).includes(value);

export const ownerForArea = (key: AreaKey): string => AREAS[key].owner;

export const areaLabels = (): string[] =>
  areaEntries.map(([, area]) => area.label);

export const developerLabelsAllowed = (labels: readonly string[]): boolean => {
  const names = new Set(labels.map(normalize));
  return (
    names.has(normalize(BUG_LABEL)) ||
    (names.has(normalize(FEATURE_REQUEST_LABEL)) &&
      names.has(normalize(APPROVED_LABEL)))
  );
};

export const hasLabel = (labels: readonly string[], wanted: string): boolean =>
  labels.some((label) => normalize(label) === normalize(wanted));

export const specificAreaForFiles = (
  files: readonly string[]
): AreaKey | null =>
  SPECIFIC_CRM_ORDER.find((key) =>
    files.some((file) => pathMatches([key], file) === key)
  ) ?? null;
