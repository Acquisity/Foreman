// Capability gaps (ENG-20299): something a widget investigation could not
// check. Each gap key `<area>: <missing fact>` has one open ENG ticket with the
// `fixy` label, which Fixy builds without plan approval; every conversation that
// hits it adds one comment and one to its count. No customer data is written:
// only the area, the fact, the conversation and run ids, and the reason.
import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";
import {
  commentIdFor,
  commentOnce,
  linearAppRequest,
} from "./widget-ticket-followup.js";

export const GAP_TOOL = "report_capability_gap";

/** The areas a gap can name: the support endpoints' areas, plus anything else. */
export const GAP_AREAS = [
  "account",
  "ai-generation",
  "ai-sdr",
  "billing",
  "campaigns",
  "crm-contact",
  "inboxes",
  "lead-pipeline",
  "orders",
  "website",
  "help-centre",
  "other",
] as const;

export interface CapabilityGap {
  area: string;
  fact: string;
  /** `docs` is a Help Centre gap, filed with Docs Gap instead of Capability Gap. */
  kind: "docs" | "tool";
  /** Why the read failed (error, timeout), for an endpoint or tool result. */
  reason?: string;
  source: "code" | "investigator";
}

export const gapKey = (gap: Pick<CapabilityGap, "area" | "fact">) =>
  `${gap.area}: ${gap.fact}`;

const FACT_MAX = 160;
const CUSTOMER_DATA = [
  /\S@\S/u,
  /\bhttps?:\/\//iu,
  /\b[a-z0-9-]+\.(?:[a-z]{2,24})\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-/iu,
  /\d{4,}/u,
  /["“”]/u,
];

/** A missing fact in general terms, or null when it names something from a workspace. */
export const generalFact = (text: string): string | null => {
  const fact = text.replace(/\s+/gu, " ").trim();
  if (
    fact.length < 3 ||
    fact.length > FACT_MAX ||
    CUSTOMER_DATA.some((pattern) => pattern.test(fact))
  ) {
    return null;
  }
  return fact.charAt(0).toLowerCase() + fact.slice(1);
};

// Hand-written tools and generated endpoint tools both start with widget_;
// these are not workspace reads.
const NOT_READS = new Set([
  "widget_ask_customer",
  "widget_file_ticket",
  "widget_help_article",
  "widget_read_help_article",
  "widget_known_issues",
  "widget_read_recording",
]);
/**
 * Each hand-written tool's support endpoint area (the parent ticket's handoff),
 * so a gap keeps its key when the area switches to its endpoint. Job failures
 * are split across orders, lead pipeline and AI generation there, so its key
 * changes when it goes.
 */
const TOOL_AREAS: Readonly<Record<string, string>> = {
  widget_account_access: "account",
  widget_billing_summary: "billing",
  widget_crm_contact: "crm-contact",
  widget_generation_diagnostics: "ai-generation",
  widget_inbox_health: "inboxes",
  widget_job_failures: "jobs",
  widget_lead_pipeline_status: "lead-pipeline",
  widget_outreach_health: "campaigns",
  widget_provisioning_status: "orders",
  widget_sdr_thread_status: "ai-sdr",
  widget_website_status: "website",
};
const READ_FAILED = new Set(["error", "timeout"]);
const unavailableSections = z.array(
  z.looseObject({ reason: z.string(), section: z.string().max(100) })
);
/** widget_billing_summary names each failed source first: `stripe: <reason>`, `productDb.creditHistory read unavailable`. */
const billingSources = z.array(z.string().max(500));
const SOURCE = /^[a-z][a-zA-Z]{0,40}(?:\.[a-z][a-zA-Z]{0,40})?/u;
// A nested key is a field name the tool wrote, never a record's name.
const FIELD = /^[a-z][a-zA-Z0-9]{0,40}$/u;
const REASON = /^[a-z][a-z_]{0,40}$/u;
const NESTED_DEPTH = 3;
/** eve's result for a call the framework refused, or whose input failed validation, before any read ran. */
const NOT_RUN =
  /^(?:AI_)?(?:InvalidToolInput|InvalidArgument|TypeValidation|NoSuchTool)Error$|^ZodError$/u;
const recordedGap = z.object({
  gap: z.object({
    area: z.enum(GAP_AREAS),
    fact: z.string().max(FACT_MAX),
    kind: z.enum(["docs", "tool"]),
  }),
  recorded: z.literal(true),
});

/**
 * The gaps one tool result shows: a widget read that failed or came back
 * unavailable, each endpoint section unreadable for an error or a timeout, and
 * what report_capability_gap recorded. Refusals by design (denied,
 * feature_off, invalid_input, not_linked, a section whose feature is off)
 * show none.
 */
export function gapsFromResult(result: unknown): CapabilityGap[] {
  const action = result as {
    isError?: boolean;
    kind?: string;
    output?: unknown;
    toolName?: unknown;
  } | null;
  if (action?.kind !== "tool-result" || typeof action.toolName !== "string") {
    return [];
  }
  const tool = action.toolName;
  if (tool === GAP_TOOL) {
    const parsed = recordedGap.safeParse(action.output);
    return parsed.success && !action.isError
      ? [{ ...parsed.data.gap, source: "investigator" }]
      : [];
  }
  if (!tool.startsWith("widget_") || NOT_READS.has(tool)) {
    return [];
  }
  const area =
    TOOL_AREAS[tool] ?? tool.slice("widget_".length).replaceAll("_", "-");
  const whole = (reason: string): CapabilityGap[] => [
    {
      area,
      fact: "the whole check could not be read",
      kind: "tool",
      reason,
      source: "code",
    },
  ];
  const output = action.output as {
    code?: unknown;
    sections?: unknown;
    status?: unknown;
    unavailable?: unknown;
  } | null;
  if (action.isError) {
    const { errorName } = action as { errorName?: unknown };
    const notRun =
      output?.code === "TOOL_EXECUTION_DENIED" ||
      (typeof errorName === "string" && NOT_RUN.test(errorName));
    return notRun ? [] : whole("error");
  }
  if (output?.status === "unavailable") {
    return whole("unavailable");
  }
  const section = (name: string, reason: string): CapabilityGap => ({
    area,
    fact: `the ${name} section could not be read`,
    kind: "tool",
    reason,
    source: "code",
  });
  const endpoint = unavailableSections.safeParse(output?.unavailable);
  // Only an endpoint body carries sections; its own section data is not walked.
  if (endpoint.success && output && "sections" in output) {
    return endpoint.data
      .filter((entry) => READ_FAILED.has(entry.reason))
      .map((entry) => section(entry.section, entry.reason));
  }
  const billing = billingSources.safeParse(output?.unavailable);
  return [
    ...(billing.success
      ? billing.data.flatMap((entry) => {
          const name = SOURCE.exec(entry)?.[0];
          return name ? [section(name, "unavailable")] : [];
        })
      : []),
    ...nestedUnavailable(output, "").map(({ path, reason }) =>
      section(path, reason)
    ),
  ];
}

/**
 * A source a hand-written tool reports as `{ status: "unavailable" }` inside
 * a result that is otherwise ok (account's Sentry signals, generation's
 * error sources, website's render), named by its field path. Lists are not
 * walked: their entries are records, not sources.
 */
function nestedUnavailable(
  value: unknown,
  path: string,
  depth = 0
): { path: string; reason: string }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const node = value as Record<string, unknown>;
  if (path && node.status === "unavailable") {
    const reason = typeof node.reason === "string" ? node.reason : "";
    return [{ path, reason: REASON.test(reason) ? reason : "unavailable" }];
  }
  if (depth >= NESTED_DEPTH) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    FIELD.test(key)
      ? nestedUnavailable(child, path ? `${path}.${key}` : key, depth + 1)
      : []
  );
}

/** One entry per gap key; the first occurrence keeps its reason. */
export const distinctGaps = (gaps: readonly CapabilityGap[]) => {
  const byKey = new Map<string, CapabilityGap>();
  for (const gap of gaps) {
    const key = gapKey(gap).toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, gap);
    }
  }
  return [...byKey.values()];
};

export interface GapOccurrence {
  conversationId: string;
  runId: string;
}

const LABELS = { docs: "Docs Gap", tool: "Capability Gap" } as const;
const FIXY = "fixy";
const COUNT_LINE = /^([-*] Conversations: )(\d{1,9})$/mu;

export const gapTitle = (gap: CapabilityGap) =>
  `${gap.kind === "docs" ? "Docs gap" : "Capability gap"}: ${gapKey(gap)}`.slice(
    0,
    255
  );

export const gapDescription = (gap: CapabilityGap) =>
  [
    gap.kind === "docs"
      ? "The support widget could not answer a customer from the Help Centre: the docs do not cover this."
      : "The support widget could not check this for a customer: no Foreman tool or support endpoint returns it, or the read failed.",
    "Each comment below names one support conversation that hit this gap. Fixy builds the fix without plan approval when it only adds or repairs a read or a Help Centre page (Aaron, 2026-11-23); anything that adds an action or moves money still waits for approval. After the fix is live, Fixy reruns the check for each conversation and answers the ones still open.",
    "## Capability gap",
    [
      `- Gap key: ${gapKey(gap)}`,
      `- Area: ${gap.area}`,
      `- Kind: ${gap.kind}`,
      `- Found by: ${gap.source === "code" ? "Foreman's code, from a tool result" : "the investigator"}`,
      "- Conversations: 1",
    ].join("\n"),
  ].join("\n\n");

export const countedDescription = (description: string, count: number) =>
  description.replace(
    COUNT_LINE,
    (_line, prefix: string) => `${prefix}${count}`
  );

const OCCURRENCE = "Seen in support conversation ";
const occurrenceBody = (gap: CapabilityGap, seen: GapOccurrence) =>
  [
    `${OCCURRENCE}${seen.conversationId} (Foreman run ${seen.runId}).`,
    ...(gap.reason ? [`Reason: ${gap.reason}.`] : []),
  ].join(" ");

const FIND = `query CapabilityGapFind($team: String!, $title: String!) {
  issues(first: 5, filter: { team: { key: { eq: $team } }, title: { eqIgnoreCase: $title }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { id identifier description labels { nodes { id } } comments(first: 250) { nodes { body } } }
  }
  teams(filter: { key: { eq: $team } }) { nodes { id } }
  issueLabels(first: 20, filter: { name: { in: ["Capability Gap", "Docs Gap", "fixy"] }, or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) { nodes { id name } }
}`;
const CREATE = `mutation CapabilityGapCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { issue { id identifier } }
}`;
const COUNT = `mutation CapabilityGapCount($id: String!, $description: String!) {
  issueUpdate(id: $id, input: { description: $description }) { success }
}`;
const ADD_LABEL = `mutation CapabilityGapLabel($id: String!, $label: String!) {
  issueAddLabel(id: $id, labelId: $label) { success }
}`;

interface Found {
  issueLabels: { nodes: { id: string; name: string }[] };
  issues: {
    nodes: {
      comments: { nodes: { body: string }[] };
      description: string | null;
      id: string;
      identifier: string;
      labels: { nodes: { id: string }[] };
    }[];
  };
  teams: { nodes: { id: string }[] };
}

export type GapFiling =
  | { identifier: string; outcome: "counted" | "filed" | "seen" }
  | { outcome: "failed"; reason: string };

/**
 * Files the gap's ticket or counts this conversation on the open one. Each
 * conversation is one comment under a fixed id per ticket and conversation,
 * so it is counted once however often it hits the gap, and the count is
 * read back from those comments. `fixy` goes on last, after the ticket holds
 * what Fixy's run reads. Every write is checked and every call reconciles
 * the open ticket, so a retry repairs a count or label an earlier failure
 * left behind.
 */
export async function fileCapabilityGap(
  gap: CapabilityGap,
  seen: GapOccurrence,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest,
  teamKey = "ENG"
): Promise<GapFiling> {
  const title = gapTitle(gap);
  const found = await request<Found>(
    "CapabilityGapFind",
    FIND,
    { team: teamKey, title },
    signal
  );
  const write = async (name: string, query: string, variables: object) => {
    const result = await request<Record<string, { success: boolean }>>(
      name,
      query,
      variables as Parameters<typeof request>[2],
      signal
    );
    if (!Object.values(result)[0]?.success) {
      throw new Error(`Linear did not confirm ${name}.`);
    }
  };
  const label = (name: string) =>
    found.issueLabels.nodes.find((node) => node.name === name)?.id;
  const fixyLabel = label(FIXY);
  const record = (issueId: string) =>
    commentOnce(
      issueId,
      occurrenceBody(gap, seen),
      commentIdFor(`capability-gap:${issueId}:${seen.conversationId}`),
      signal,
      request
    );
  const [open] = found.issues.nodes;
  if (open) {
    const added = await record(open.id);
    const count =
      open.comments.nodes.filter((comment) =>
        comment.body.startsWith(OCCURRENCE)
      ).length + (added ? 1 : 0);
    const description = open.description ?? "";
    const counted = countedDescription(description, count);
    if (counted !== description) {
      await write("CapabilityGapCount", COUNT, {
        description: counted,
        id: open.id,
      });
    }
    if (fixyLabel && !open.labels.nodes.some(({ id }) => id === fixyLabel)) {
      await write("CapabilityGapLabel", ADD_LABEL, {
        id: open.id,
        label: fixyLabel,
      });
    }
    return { identifier: open.identifier, outcome: added ? "counted" : "seen" };
  }
  const teamId = found.teams.nodes[0]?.id;
  const kindLabel = label(LABELS[gap.kind]);
  if (!(teamId && kindLabel && fixyLabel)) {
    return {
      outcome: "failed",
      reason: `Linear has no ${teamKey} team, ${LABELS[gap.kind]} label or ${FIXY} label.`,
    };
  }
  const created = await request<{
    issueCreate: { issue: { id: string; identifier: string } | null };
  }>(
    "CapabilityGapCreate",
    CREATE,
    {
      input: {
        description: gapDescription(gap),
        labelIds: [kindLabel],
        teamId,
        title,
      },
    },
    signal
  );
  const { issue } = created.issueCreate;
  if (!issue) {
    return { outcome: "failed", reason: "Linear did not confirm the ticket." };
  }
  await record(issue.id);
  await write("CapabilityGapLabel", ADD_LABEL, {
    id: issue.id,
    label: fixyLabel,
  });
  return { identifier: issue.identifier, outcome: "filed" };
}

const GAPS_MS = 60_000;

/**
 * Files every gap a run recorded, one after another. It starts beside the
 * run's finish and the finish awaits it only after the reply is saved, so it
 * never delays the customer; a failure is logged and never reaches them.
 */
export async function fileRunGaps(
  gaps: readonly CapabilityGap[],
  seen: GapOccurrence,
  signal: AbortSignal = AbortSignal.timeout(GAPS_MS),
  file: typeof fileCapabilityGap = fileCapabilityGap
): Promise<void> {
  for (const gap of distinctGaps(gaps)) {
    // biome-ignore lint/performance/noAwaitInLoops: one ticket per key, filed in order.
    const filed = await file(gap, seen, signal).catch(
      (error): GapFiling => ({
        outcome: "failed",
        reason: error instanceof Error ? error.name : "error",
      })
    );
    logOpsEvent("widget.capability_gap", {
      conversationId: seen.conversationId,
      outcome: filed.outcome,
      runId: seen.runId,
      tool: gap.area,
      ...(filed.outcome === "failed"
        ? { code: filed.reason }
        : { issue: filed.identifier }),
    });
  }
}
