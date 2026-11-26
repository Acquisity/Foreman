// Capability gaps (ENG-20299): something a widget investigation could not
// check. Each gap key `<area>: <missing fact>` has one open ENG ticket, which
// Fixy's daily triage judges, labelling `fixy` only what it builds; every
// conversation that hits it adds one comment and one to its count. Internal
// workspaces and conversations a closed ticket already judged file nothing.
// No customer data is written: only the area, the fact, the conversation and
// run ids, and the reason.
import { z } from "zod";
import { INTERNAL_ORGS } from "./internal-orgs.js";
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
  "jobs",
  "lead-pipeline",
  "orders",
  "website",
  "help-centre",
  "other",
] as const;

export interface CapabilityGap {
  area: string;
  /** What a reply said it could not check, in general terms, for its conversation's comment. */
  details?: string[];
  fact: string;
  /** `docs` is a Help Centre gap, filed with Docs Gap instead of Capability Gap. */
  kind: "docs" | "tool";
  /** Why the read failed (error, timeout), for an endpoint or tool result. */
  reason?: string;
  /** `reply`: the extraction pass read it from what the reply said it could not check. */
  source: "code" | "investigator" | "reply";
}

export const gapKey = (gap: Pick<CapabilityGap, "area" | "fact">) =>
  `${gap.area}: ${gap.fact}`;

const FACT_MAX = 160;
// "DNS status" stays as it is; "Why a domain" becomes "why a domain".
const ACRONYM = /^[A-Z]{2}/u;
const CUSTOMER_DATA = [
  /\S@\S/u,
  /\bhttps?:\/\//iu,
  /\b[a-z0-9-]+\.(?:[a-z]{2,24})\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-/iu,
  /\d{4,}/u,
  /["“”]/u,
  // A capitalized word after the first is a name (a person, a company, a
  // campaign); product terms are written in lower case.
  /\s[A-Z][a-z]/u,
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
  return ACRONYM.test(fact)
    ? fact
    : fact.charAt(0).toLowerCase() + fact.slice(1);
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
const toolArea = (tool: string) =>
  tool.slice("widget_".length).replaceAll("_", "-");
const READ_FAILED = new Set(["error", "timeout"]);
const unavailableSections = z.array(
  z.looseObject({ reason: z.string(), section: z.string().max(100) })
);
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
  const area = toolArea(tool);
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
  if (!(endpoint.success && output && "sections" in output)) {
    return [];
  }
  return endpoint.data
    .filter((entry) => READ_FAILED.has(entry.reason))
    .map((entry) => section(entry.section, entry.reason));
}

const WHOLE_REFUSALS = new Set([
  "denied",
  "feature_off",
  "invalid_input",
  "not_linked",
]);

/**
 * One widget read's area and whether the whole check was refused by design:
 * its own status is denied, feature_off, invalid_input or not_linked, or the
 * framework refused the call or rejected its input. A refused section inside
 * an otherwise answered read is not a refusal of the area. Null for anything
 * that isn't a widget read.
 */
export function readRefusal(
  result: unknown
): { area: string; refused: boolean } | null {
  const action = result as {
    errorName?: unknown;
    isError?: boolean;
    kind?: string;
    output?: unknown;
    toolName?: unknown;
  } | null;
  const tool = action?.toolName;
  if (
    action?.kind !== "tool-result" ||
    typeof tool !== "string" ||
    !tool.startsWith("widget_") ||
    tool === GAP_TOOL ||
    NOT_READS.has(tool)
  ) {
    return null;
  }
  const output = action.output as {
    code?: unknown;
    status?: unknown;
  } | null;
  const notRun =
    action.isError === true &&
    (output?.code === "TOOL_EXECUTION_DENIED" ||
      (typeof action.errorName === "string" && NOT_RUN.test(action.errorName)));
  const refused =
    notRun ||
    (typeof output?.status === "string" && WHOLE_REFUSALS.has(output.status));
  return { area: toolArea(tool), refused };
}

export interface UncheckedFact {
  area: (typeof GAP_AREAS)[number];
  fact: string;
  kind: "docs" | "tool";
}

const REPLY_FACTS = {
  docs: "a product question a reply said the Help Centre does not answer",
  tool: "something a reply said could not be checked",
} as const;
const DETAIL_SEPARATOR = "; ";
const NAMED_DATA = "one item that named workspace data, left out";

/**
 * What a reply said it couldn't check (ENG-20478), as one gap per area and
 * kind, so rewording never opens a second ticket; each fact goes in the
 * conversation's comment. In an area whose read failed in the same run, the
 * tool facts ride on that failure's gap instead of opening another. In an
 * area whose latest read refused the whole check by design, tool facts file
 * nothing; docs facts still do. An area a feature that is off closes for the
 * workspace files nothing at all.
 */
export function replyGaps(
  unchecked: readonly UncheckedFact[] | undefined,
  fromTools: readonly CapabilityGap[] = [],
  refused: readonly string[] = [],
  closed: readonly string[] = []
): CapabilityGap[] {
  const refusedHere = new Set(refused);
  const closedHere = new Set(closed);
  const failed = new Map<string, CapabilityGap & { details: string[] }>();
  for (const gap of fromTools) {
    if (gap.source === "code" && !failed.has(gap.area)) {
      failed.set(gap.area, { ...gap, details: [...(gap.details ?? [])] });
    }
  }
  const byKey = new Map<string, CapabilityGap & { details: string[] }>();
  for (const item of unchecked ?? []) {
    const tool = item.kind === "tool";
    if ((tool && refusedHere.has(item.area)) || closedHere.has(item.area)) {
      continue;
    }
    const key = `${item.area}:${item.kind}`;
    const gap = (tool ? failed.get(item.area) : undefined) ??
      byKey.get(key) ?? {
        area: item.area,
        details: [],
        fact: REPLY_FACTS[item.kind],
        kind: item.kind,
        source: "reply" as const,
      };
    const detail =
      generalFact(item.fact.replaceAll(DETAIL_SEPARATOR, ", ")) ?? NAMED_DATA;
    if (!gap.details.includes(detail)) {
      gap.details.push(detail);
    }
    if (!(tool && failed.has(item.area))) {
      byKey.set(key, gap);
    }
  }
  return [
    ...[...failed.values()].filter((gap) => gap.details.length > 0),
    ...byKey.values(),
  ];
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
  organizationId: string;
  runId: string;
}

const LABELS = { docs: "Docs Gap", tool: "Capability Gap" } as const;
const COUNT_LINE = /^([-*] Conversations: )(\d{1,9})$/mu;

export const gapTitle = (gap: CapabilityGap) =>
  `${gap.kind === "docs" ? "Docs gap" : "Capability gap"}: ${gapKey(gap)}`.slice(
    0,
    255
  );

const FOUND_BY = {
  code: "Foreman's code, from a tool result",
  investigator: "the investigator",
  reply:
    "the extraction pass, from what a reply told the customer it couldn't check",
} as const;

const INTRO = {
  docs: "The support widget could not answer a customer from the Help Centre: the docs do not cover this.",
  reply:
    "A support reply told a customer it couldn't check something in this area. Each comment below lists what, in general terms; test each against the conversation before building.",
  tool: "The support widget could not check this for a customer: no Foreman tool or support endpoint returns it, or the read failed.",
} as const;

export const gapDescription = (gap: CapabilityGap) =>
  [
    INTRO[gap.source === "reply" ? "reply" : gap.kind],
    "Each comment below names one support conversation that hit this gap. Fixy's daily triage judges whether this would have changed the reply and can be known from our data, and adds the `fixy` label only when there is something to build; otherwise it cancels the ticket with the reason, with no plan card, question card or draft (Aaron, 2026-11-25). A fix that would add an action, write customer data or move money becomes its own ENG ticket without the `fixy` label, linked from this one. After a read or Help Centre fix is live, Fixy reruns the check for each conversation and answers the ones whose question it now answers and that are still waiting.",
    "## Capability gap",
    [
      `- Gap key: ${gapKey(gap)}`,
      `- Area: ${gap.area}`,
      `- Kind: ${gap.kind}`,
      `- Found by: ${FOUND_BY[gap.source]}`,
      "- Conversations: 1",
    ].join("\n"),
  ].join("\n\n");

export const countedDescription = (description: string, count: number) =>
  description.replace(
    COUNT_LINE,
    (_line, prefix: string) => `${prefix}${count}`
  );

const OCCURRENCE = "Seen in support conversation ";
const COULD_NOT_CHECK = " Couldn't check: ";
const TRAILING_STOP = /\.$/u;
const occurrenceBody = (gap: CapabilityGap, seen: GapOccurrence) =>
  [
    `${OCCURRENCE}${seen.conversationId} (Foreman run ${seen.runId}).`,
    ...(gap.reason ? [`Reason: ${gap.reason}.`] : []),
  ].join(" ") +
  (gap.details?.length
    ? `${COULD_NOT_CHECK}${gap.details.join(DETAIL_SEPARATOR)}.`
    : "");

/** A conversation's comment with any of these facts it doesn't list yet, or null when it lists them all. */
export const withDetails = (
  body: string,
  details: readonly string[] = []
): string | null => {
  const at = body.indexOf(COULD_NOT_CHECK);
  const listed =
    at < 0
      ? []
      : body
          .slice(at + COULD_NOT_CHECK.length)
          .replace(TRAILING_STOP, "")
          .split(DETAIL_SEPARATOR);
  const added = details.filter((detail) => !listed.includes(detail));
  if (added.length === 0) {
    return null;
  }
  const head = at < 0 ? body : body.slice(0, at);
  return `${head}${COULD_NOT_CHECK}${[...listed, ...added].join(DETAIL_SEPARATOR)}.`;
};

// Linear's Duplicate state has its own type, `duplicate`.
const FIND = `query CapabilityGapFind($team: String!, $title: String!, $since: DateTimeOrDuration!, $seen: String!) {
  issues(first: 5, filter: { team: { key: { eq: $team } }, title: { eqIgnoreCase: $title }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
    nodes { id identifier description labels { nodes { id } } comments(first: 250) { nodes { id body } } }
  }
  judged: issues(first: 1, filter: { team: { key: { eq: $team } }, title: { eqIgnoreCase: $title }, state: { type: { in: ["completed", "canceled", "duplicate"] } }, or: [{ completedAt: { gt: $since } }, { canceledAt: { gt: $since } }], comments: { some: { body: { startsWith: $seen } } } }) {
    nodes { identifier }
  }
  teams(filter: { key: { eq: $team } }) { nodes { id } }
  issueLabels(first: 20, filter: { name: { in: ["Capability Gap", "Docs Gap"] }, or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }) { nodes { id name } }
}`;
/** How long after closing a ticket still counts as having judged its conversations; Duplicate sets canceledAt. */
const JUDGED_WINDOW = "-P30D";
const CREATE = `mutation CapabilityGapCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { issue { id identifier } }
}`;
const COUNT = `mutation CapabilityGapCount($id: String!, $description: String!) {
  issueUpdate(id: $id, input: { description: $description }) { success }
}`;
const UPDATE_COMMENT = `mutation CapabilityGapDetails($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) { success }
}`;
const ADD_LABEL = `mutation CapabilityGapLabel($id: String!, $label: String!) {
  issueAddLabel(id: $id, labelId: $label) { success }
}`;

interface Found {
  issueLabels: { nodes: { id: string; name: string }[] };
  issues: {
    nodes: {
      comments: { nodes: { body: string; id: string }[] };
      description: string | null;
      id: string;
      identifier: string;
      labels: { nodes: { id: string }[] };
    }[];
  };
  judged: { nodes: { identifier: string }[] };
  teams: { nodes: { id: string }[] };
}

const occurrences = (comments: readonly { body: string }[]) =>
  comments.filter((comment) => comment.body.startsWith(OCCURRENCE)).length;

export type GapFiling =
  | { identifier: string; outcome: "counted" | "filed" | "judged" | "seen" }
  | { outcome: "failed"; reason: string };

/**
 * Files the gap's ticket or counts this conversation on the open one. Each
 * conversation is one comment under a fixed id per ticket and conversation,
 * so it is counted once however often it hits the gap, and the count is
 * read back from those comments. A conversation already on a ticket with
 * this title that closed in the last 30 days has been judged: nothing is
 * written. The kind label goes on last, after the ticket holds what Fixy's
 * daily triage reads, because the triage picks tickets up by that label; the
 * `fixy` label is never added here. Every write is checked and every call
 * reconciles the open ticket, so a retry repairs a count or label an earlier
 * failure left behind.
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
    {
      seen: `${OCCURRENCE}${seen.conversationId} `,
      since: JUDGED_WINDOW,
      team: teamKey,
      title,
    },
    signal
  );
  const [judged] = found.judged.nodes;
  if (judged) {
    return { identifier: judged.identifier, outcome: "judged" };
  }
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
  const kindLabel = found.issueLabels.nodes.find(
    (node) => node.name === LABELS[gap.kind]
  )?.id;
  const commentId = (issueId: string) =>
    commentIdFor(`capability-gap:${issueId}:${seen.conversationId}`);
  const record = (issueId: string) =>
    commentOnce(
      issueId,
      occurrenceBody(gap, seen),
      commentId(issueId),
      signal,
      request
    );
  const [open] = found.issues.nodes;
  if (open) {
    const added = await record(open.id);
    // A later run in the same conversation adds what its reply couldn't check
    // to that conversation's one comment (ENG-20478).
    const mine = added
      ? undefined
      : open.comments.nodes.find(({ id }) => id === commentId(open.id));
    const merged = mine && withDetails(mine.body, gap.details);
    if (mine && merged) {
      await write("CapabilityGapDetails", UPDATE_COMMENT, {
        body: merged,
        id: mine.id,
      });
    }
    const count = occurrences(open.comments.nodes) + Number(added);
    const description = open.description ?? "";
    const counted = countedDescription(description, count);
    if (counted !== description) {
      await write("CapabilityGapCount", COUNT, {
        description: counted,
        id: open.id,
      });
    }
    if (kindLabel && !open.labels.nodes.some(({ id }) => id === kindLabel)) {
      await write("CapabilityGapLabel", ADD_LABEL, {
        id: open.id,
        label: kindLabel,
      });
    }
    return { identifier: open.identifier, outcome: added ? "counted" : "seen" };
  }
  const teamId = found.teams.nodes[0]?.id;
  if (!(teamId && kindLabel)) {
    return {
      outcome: "failed",
      reason: `Linear has no ${teamKey} team or ${LABELS[gap.kind]} label.`,
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
    label: kindLabel,
  });
  return { identifier: issue.identifier, outcome: "filed" };
}

const GAPS_MS = 60_000;

/**
 * Files every gap a run recorded, one after another. It starts beside the
 * run's finish and the finish awaits it only after the reply is saved, so it
 * never delays the customer; a failure is logged and never reaches them. A
 * run in an internal workspace files nothing and logs each gap skipped.
 */
export async function fileRunGaps(
  gaps: readonly CapabilityGap[],
  seen: GapOccurrence,
  signal: AbortSignal = AbortSignal.timeout(GAPS_MS),
  file: typeof fileCapabilityGap = fileCapabilityGap
): Promise<void> {
  const internal = INTERNAL_ORGS.has(seen.organizationId.toLowerCase());
  for (const gap of distinctGaps(gaps)) {
    if (internal) {
      logOpsEvent("widget.capability_gap", {
        conversationId: seen.conversationId,
        outcome: "skipped_internal",
        runId: seen.runId,
        tool: gap.area,
      });
      continue;
    }
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
