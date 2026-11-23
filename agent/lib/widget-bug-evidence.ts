import { z } from "zod";
import {
  collectRows,
  DATASET_NAME,
} from "../tools/widget_generation_diagnostics.js";
import { readRecording } from "../tools/widget_read_recording.js";
import { invokeProvider, type ProviderContext } from "./executor/dispatch.js";
import { mcpResultText } from "./executor/mcp-result.js";
import { logOpsEvent } from "./ops-log.js";
import { providerData } from "./support/conversation.js";
import {
  INNGEST_READ,
  inngestRunsInput,
  POSTHOG_READ,
  posthogQuery,
} from "./widget-policy.js";
import type { WidgetContext } from "./widget-scope.js";
import { appTicketContext } from "./widget-ticket.js";

/**
 * The evidence an "I found a bug" ticket carries (ENG-17031, ENG-20083): what
 * the app captured in the customer's browser, and Sentry, Axiom, Inngest,
 * PostHog and Jam lookups scoped to the verified workspace or user.
 */
const SENTRY_ID = /^[A-Za-z0-9-]{8,64}$/u;
/** A pathname only: no query, fragment, whitespace or markup. */
const PAGE = /^\/[^?#\s<>]{0,299}$/u;
/** The capture's `HH:MM:SS METHOD /path status Nms`, so a request line carries no URL query, header or body. */
const FAILED_REQUEST =
  /^\d{2}:\d{2}:\d{2} [A-Z]{1,10} (?:\/[^?#\s<>]{0,299}|\(unknown\)) (?:\d{3}|network error) \d{1,9}ms$/u;

/**
 * What Acquisity's widget captured when the customer tapped "I found a bug"
 * (its SupportReportBrowser): the page's pathname, the Sentry replay of the
 * last minute, and recent console errors and failed requests, with no bodies,
 * headers, cookies or query strings. The route drops an invalid one rather
 * than refuse the report.
 */
export const bugReportBrowserSchema = z.object({
  browser: z.string().max(200),
  consoleErrors: z.array(z.string().max(500)).max(30),
  failedRequests: z.array(z.string().max(500)).max(30),
  page: z.string().regex(PAGE),
  replayId: z.string().regex(SENTRY_ID).nullable(),
  screen: z.string().max(20),
  sentryEventIds: z.array(z.string().regex(SENTRY_ID)).max(5),
});
export type BugReportBrowser = z.infer<typeof bugReportBrowserSchema>;

/** The capture at its schema limits: page, browser, screen, the replay and five event ids, and sixty console and request lines. */
export const MAX_BROWSER_CHARS = 300 + 200 + 20 + 6 * 64 + 60 * 500;

/** The widget's capture, or nothing when it is missing or invalid: a bad capture never stops the report. */
export const bugReportBrowser = (capture: unknown) => {
  const parsed = bugReportBrowserSchema.safeParse(capture);
  return parsed.success ? { browser: parsed.data } : {};
};

export interface BugReportTurn {
  browser?: BugReportBrowser;
  history?: { role: "customer" | "assistant"; text: string }[];
  messageId: string;
  question: string;
  recording?: { id: string };
  reportedAt?: string;
  screenshots?: string[];
}

export interface EvidenceItem {
  text: string;
  url?: string;
}
export type Evidence =
  | {
      items: EvidenceItem[];
      /** The last page the source saw the customer on. */
      page?: string;
      recording?: EvidenceItem;
      status: "found";
    }
  | { status: "empty" }
  /** Nothing to look up: the app or the customer sent nothing for this source. */
  | { status: "not_sent" }
  | { reason: string; status: "unchecked" };

export type Lookup = (
  ctx: ProviderContext,
  scope: WidgetContext,
  turn: BugReportTurn
) => Promise<Evidence>;

export const ITEMS_MAX = 8;
const ITEM_CHARS = 300;
const READ_OPTIONS = { maxBytes: 64 * 1024, timeoutMs: 20_000 };
/** Every lookup together; a slow source is reported unchecked and the ticket is still filed. */
const EVIDENCE_MS = 45_000;

export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const found = (items: EvidenceItem[]): Evidence =>
  items.length ? { items, status: "found" } : { status: "empty" };

export const inWords = (date: Date) =>
  `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;

/** `10:21:15 UTC`, for times within the hour before the report. */
const clock = (iso: string) => {
  const time = Date.parse(iso);
  return Number.isFinite(time)
    ? `${new Date(time).toISOString().slice(11, 19)} UTC`
    : null;
};

const read = async (
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
) => {
  const result = await invokeProvider(
    ctx,
    path,
    input,
    undefined,
    READ_OPTIONS
  );
  if (!result.ok || (result.http && result.http.status !== 200)) {
    throw new Error("Provider unavailable.");
  }
  return result.data;
};

const MARKDOWN = /[#*`]/gu;
const SENTRY_ISSUE_ID = /\[([^\]]+)\]/u;
const SENTRY_ISSUE_URL =
  /https:\/\/[\w.-]*sentry\.io\/[^\s)\]]*issues\/[^\s)\]]+/u;

const sentryIssues = z.object({ issues: z.array(z.unknown()) });
// Each issue is checked on its own, so one oversized field drops only that issue.
const sentryIssue = z.object({
  shortId: z.string().max(100),
  title: z.string().max(2000).optional(),
  url: z.string().max(2000),
});

/** Sentry answers search_issues as structured issues, or in markdown: each issue a `## n. [ID](link)` heading, then its title in bold. */
const sentry: Lookup = async (ctx, scope) => {
  const organizationSlug = process.env.WIDGET_SENTRY_ORG_SLUG;
  if (!organizationSlug) {
    return { reason: "WIDGET_SENTRY_ORG_SLUG is not set", status: "unchecked" };
  }
  const data = (await read(ctx, "sentry-foreman.search_issues", {
    limit: ITEMS_MAX,
    organizationSlug,
    query: `tags[organizationId]:${scope.organizationId} lastSeen:-24h`,
    sort: "date",
  })) as { structuredContent?: unknown } | null;
  // v2 Sentry returns the issues as structured data with empty content.
  if (
    data?.structuredContent !== undefined &&
    data.structuredContent !== null
  ) {
    const structured = sentryIssues.safeParse(data.structuredContent);
    if (!structured.success) {
      return {
        reason: "Sentry returned an unexpected result shape",
        status: "unchecked",
      };
    }
    return found(
      structured.data.issues
        .flatMap((issue) => {
          const parsed = sentryIssue.safeParse(issue);
          return parsed.success ? [parsed.data] : [];
        })
        .filter(({ url }) => SENTRY_ISSUE_URL.test(url))
        .map(({ shortId, title, url }) => ({
          text: clip([shortId, title].filter(Boolean).join(": "), ITEM_CHARS),
          url,
        }))
    );
  }
  const lines = (mcpResultText(data) ?? "").split("\n");
  const issues: { id: string; title?: string; url: string }[] = [];
  for (const line of lines) {
    const url = line.startsWith("#") ? SENTRY_ISSUE_URL.exec(line)?.[0] : null;
    if (url) {
      issues.push({ id: SENTRY_ISSUE_ID.exec(line)?.[1] ?? "", url });
    } else if (
      line.startsWith("**") &&
      issues.at(-1) &&
      !issues.at(-1)?.title
    ) {
      const last = issues.at(-1);
      if (last) {
        last.title = line.replace(MARKDOWN, "").trim();
      }
    }
  }
  return found(
    issues.map(({ id, title, url }) => ({
      text: clip([id, title].filter(Boolean).join(": ") || url, ITEM_CHARS),
      url,
    }))
  );
};

const CSV_BLOCK = /^# [\w.-]+\.csv$/u;
const NO_ROWS = /^No [^,\n]*\.$/u;
const JSON_START = /^\s*[[{]/u;

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks. */
const csvRecords = (text: string) => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (quoted) {
    throw new Error("Unrecognized Axiom response.");
  }
  record.push(field);
  records.push(record);
  return records;
};

/** Each `# name.csv` table's records, up to its first blank line. */
const csvTables = (text: string) => {
  const tables: { closed: boolean; records: string[][] }[] = [];
  for (const record of csvRecords(text)) {
    const table = tables.at(-1);
    if (record.length === 1 && CSV_BLOCK.test(record[0] ?? "")) {
      tables.push({ closed: false, records: [] });
    } else if (!record.some(Boolean)) {
      if (table?.records.length) {
        table.closed = true;
      }
    } else if (table && !table.closed) {
      table.records.push(record);
    }
  }
  return tables;
};

/**
 * Axiom's MCP answers in CSV text, each table under a `# name.csv` line, and
 * says "No … found." under it when a table is empty. Tables are framed on
 * whole records, so a quoted log line shaped like a heading stays in its row,
 * and a table ends at its first blank line, before any footer such as the
 * query budget or an "Open in Axiom" link. A row must have one field per
 * column. The query's table is the one whose header names `message`. Structured or
 * JSON rows, the shape this lookup read before, are still accepted.
 */
const axiomRows = (data: unknown): Record<string, unknown>[] => {
  const result = data as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  } | null;
  if (result?.isError === true) {
    throw new Error("Axiom could not run the query.");
  }
  const text = mcpResultText({ content: result?.content }) ?? "";
  if (
    result?.structuredContent ||
    !Array.isArray(result?.content) ||
    JSON_START.test(text)
  ) {
    const rows = collectRows(providerData(data));
    if (!rows) {
      throw new Error("Unrecognized Axiom response.");
    }
    return rows.map((row) => (row ?? {}) as Record<string, unknown>);
  }
  const tables = csvTables(text);
  for (const {
    records: [header, ...rows],
  } of tables) {
    if (header?.includes("message")) {
      if (rows.some((row) => row.length !== header.length)) {
        throw new Error("Unrecognized Axiom response.");
      }
      return rows.map((row) =>
        Object.fromEntries(header.map((name, column) => [name, row[column]]))
      );
    }
  }
  const only = tables[0]?.records;
  if (
    tables.length === 1 &&
    only?.length === 1 &&
    only[0]?.length === 1 &&
    NO_ROWS.test(only[0][0] ?? "")
  ) {
    return [];
  }
  throw new Error("Unrecognized Axiom response.");
};

/** Error logs from the day before the report that name this workspace, or name this user and no workspace: a user's row from another workspace names that workspace. */
const axiom: Lookup = async (ctx, scope, turn) => {
  const dataset = process.env.WIDGET_AXIOM_APP_DATASET;
  if (!(dataset && DATASET_NAME.test(dataset))) {
    return {
      reason: "WIDGET_AXIOM_APP_DATASET is not set",
      status: "unchecked",
    };
  }
  const to = turn.reportedAt ? new Date(turn.reportedAt) : new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const apl = [
    `['${dataset}']`,
    `| where _time >= datetime('${from.toISOString()}') and _time <= datetime('${to.toISOString()}')`,
    `| where tostring(['fields']['organizationId']) == '${scope.organizationId}' or (isempty(tostring(['fields']['organizationId'])) and tostring(['fields']['userId']) == '${scope.userId}')`,
    "| where tostring(['level']) in ('error', 'fatal')",
    "| summarize count = count(), lastSeen = max(_time) by message",
    "| sort by lastSeen desc",
    // max(_time) comes back as epoch nanoseconds; this makes it an ISO time.
    "| extend lastSeen = tostring(todatetime(lastSeen))",
    `| limit ${ITEMS_MAX}`,
  ].join("\n");
  const rows = axiomRows(
    await read(ctx, "axiom-foreman.queryDataset", { apl })
  );
  return found(
    rows.flatMap(({ count, lastSeen, message }) => {
      if (typeof message !== "string" || !message) {
        return [];
      }
      const last =
        typeof lastSeen === "string" ? Date.parse(lastSeen) : Number.NaN;
      return [
        {
          text: clip(
            `${message} (${String(count || 1)} times${Number.isFinite(last) ? `, last ${inWords(new Date(last))}` : ""})`,
            ITEM_CHARS
          ),
        },
      ];
    })
  );
};

const inngestPage = z.object({
  data: z
    .array(
      z.object({
        endedAt: z.string().max(100).nullish(),
        function: z
          .object({
            id: z.string().max(500).optional(),
            name: z.string().max(500).optional(),
          })
          .optional(),
        id: z.string().min(1).max(200),
      })
    )
    .optional(),
  // Every answer measured carries page, even an empty one.
  page: z.object({
    cursor: z.string().max(2000).optional(),
    hasMore: z.boolean().optional(),
    limit: z.number(),
  }),
});
/** A filtered scan can return an empty page that still has more; a few pages stay inside the deadline. */
const INNGEST_PAGES = 3;

/** This workspace's failed runs in the hour before the report, filtered by Inngest itself on the triggering event's organizationId. */
const inngest: Lookup = async (ctx, scope, turn) => {
  if (!turn.reportedAt) {
    throw new Error("No report time.");
  }
  const input = inngestRunsInput(
    scope.organizationId,
    new Date(turn.reportedAt)
  );
  const runs: z.infer<typeof inngestPage>["data"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < INNGEST_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous page's cursor.
    const data = (await read(ctx, INNGEST_READ.path, {
      ...input,
      ...(cursor ? { cursor } : {}),
    })) as { isError?: unknown; structuredContent?: unknown } | null;
    const parsed = inngestPage.safeParse(data?.structuredContent);
    if (
      data?.isError === true ||
      !parsed.success ||
      (parsed.data.page.hasMore && !parsed.data.page.cursor)
    ) {
      throw new Error("Unrecognized Inngest response.");
    }
    runs.push(...(parsed.data.data ?? []));
    cursor = parsed.data.page.hasMore ? parsed.data.page.cursor : undefined;
    if (!cursor || runs.length >= ITEMS_MAX) {
      break;
    }
  }
  if (!runs.length && cursor) {
    return {
      reason: `Inngest still had runs to scan after ${INNGEST_PAGES} pages`,
      status: "unchecked",
    };
  }
  return found([
    ...runs.map((run) => {
      const ended = run.endedAt ? clock(run.endedAt) : null;
      return {
        text: clip(
          `${run.function?.name ?? run.function?.id ?? "Unknown function"} failed${ended ? ` at ${ended}` : ""}`,
          ITEM_CHARS
        ),
        url: `https://app.inngest.com/env/production/runs/${encodeURIComponent(run.id)}`,
      };
    }),
    ...(cursor ? [{ text: "Inngest had more runs to scan" }] : []),
  ]);
};

const TAXONOMY_WARNINGS = /<taxonomy_warnings>[\s\S]*?<\/taxonomy_warnings>/u;
const POSTHOG_COLUMNS =
  "timestamp|event|errorCode|sessionId|recorded|$pathname";
const POSTHOG_NULL = "(null)";
const POSTHOG_SESSION = /^[\w-]{1,100}$/u;

/** PostHog answers execute-sql with a pipe-separated table: a header line, then one line per row. */
const posthogRows = (data: unknown) => {
  const result = data as { content?: { text?: unknown }[] } | null;
  const text = result?.content?.[0]?.text;
  const lines =
    typeof text === "string"
      ? text.replace(TAXONOMY_WARNINGS, "").trim().split("\n")
      : [];
  if (lines[0]?.trim() !== POSTHOG_COLUMNS) {
    throw new Error("Unrecognized PostHog response.");
  }
  return lines
    .filter((line) => line.trim())
    .slice(1, ITEMS_MAX + 1)
    .map((line) => {
      const [timestamp, event, errorCode, sessionId, recorded, ...rest] = line
        .split("|")
        .map((cell) => cell.trim());
      if (
        !rest.length ||
        (event !== "$pageview" && event !== "crm.error_toast_shown") ||
        (recorded !== "0" && recorded !== "1") ||
        !Number.isFinite(Date.parse(timestamp))
      ) {
        throw new Error("Unrecognized PostHog response.");
      }
      const path = rest.join("|");
      return {
        errorCode: errorCode === POSTHOG_NULL ? "" : errorCode,
        event,
        path: path === POSTHOG_NULL ? "" : path,
        recorded: recorded === "1" && POSTHOG_SESSION.test(sessionId),
        sessionId,
        timestamp,
      };
    });
};

/**
 * The reporting user's page views and error toasts in this workspace in the 30
 * minutes before the report. PostHog records only some sessions, so the session
 * of the newest event is linked only when PostHog recorded it, and the ticket
 * says so when it did not. The link goes under How to see it, not here.
 */
const posthog: Lookup = async (ctx, scope, turn) => {
  if (!turn.reportedAt) {
    throw new Error("No report time.");
  }
  const rows = posthogRows(
    await read(ctx, POSTHOG_READ.path, {
      query: posthogQuery(
        scope.userId,
        scope.organizationId,
        new Date(turn.reportedAt)
      ),
    })
  );
  const [latest] = rows;
  if (!latest) {
    return { status: "empty" };
  }
  const project = process.env.WIDGET_POSTHOG_PROJECT_ID;
  const recording =
    latest.recorded && project
      ? {
          text: "PostHog recording of this session",
          url: `https://us.posthog.com/project/${encodeURIComponent(project)}/replay/${encodeURIComponent(latest.sessionId)}`,
        }
      : undefined;
  const activity = rows.map(({ errorCode, event, path, timestamp }) => ({
    text: clip(
      `${event === "crm.error_toast_shown" ? `Error toast ${errorCode || "without a code"} on` : "Viewed"} ${path || "an unknown page"} at ${clock(timestamp)}`,
      ITEM_CHARS
    ),
  }));
  const page = rows.find(
    (row) => row.event === "$pageview" && PAGE.test(row.path)
  )?.path;
  const note = latest.recorded
    ? "PostHog recorded this session"
    : "No PostHog recording (we only record some sessions)";
  return {
    items: [...(recording ? [] : [{ text: note }]), ...activity],
    ...(page ? { page } : {}),
    ...(recording ? { recording } : {}),
    status: "found",
  };
};

export const jamLink = (id: string) => `https://jam.dev/c/${id}`;

const jam: Lookup = async (ctx, _scope, turn) => {
  if (!turn.recording) {
    return { status: "not_sent" };
  }
  const recording = await readRecording(ctx, turn.recording.id);
  if ("error" in recording) {
    throw new Error("Recording unreadable.");
  }
  const parts = Object.entries(recording).flatMap(([key, value]) =>
    typeof value === "string"
      ? [{ text: clip(`${key}: ${value}`, ITEM_CHARS) }]
      : []
  );
  return found([
    { text: "Screen recording", url: jamLink(turn.recording.id) },
    ...parts,
  ]);
};

const BROWSER_REQUESTS = 3;
const BROWSER_CONSOLE = 4;
/** Acquisity serializes a logged object or array as JSON, which can hold a request body or headers its redaction does not name. */
const SERIALIZED = /[[{][\s\S]*$/u;

/**
 * The newest failed requests and console errors, alternating so each kind gets
 * a line before the section's budget runs out, with the Sentry event ids first.
 */
const browser: Lookup = (_ctx, _scope, turn) => {
  const capture = turn.browser;
  if (!capture) {
    return Promise.resolve({ status: "not_sent" });
  }
  const line = (text: string) => ({ text: clip(text, ITEM_CHARS) });
  const requests = capture.failedRequests
    .filter((text) => FAILED_REQUEST.test(text))
    .slice(-BROWSER_REQUESTS)
    .reverse()
    .map((text) => line(`Request failed: ${text}`));
  const consoleErrors = capture.consoleErrors
    .slice(-BROWSER_CONSOLE)
    .reverse()
    .map((text) =>
      line(`Console: ${text.replace(SERIALIZED, "[logged object left out]")}`)
    );
  const alternating = Array.from(
    { length: Math.max(requests.length, consoleErrors.length) },
    (_, index) => [requests[index], consoleErrors[index]]
  )
    .flat()
    .filter((item) => item !== undefined);
  return Promise.resolve(
    found([
      ...(capture.sentryEventIds.length
        ? [line(`Sentry error events: ${capture.sentryEventIds.join(", ")}`)]
        : []),
      ...alternating,
    ])
  );
};

export const EVIDENCE_SOURCES = {
  Axiom: axiom,
  Browser: browser,
  Inngest: inngest,
  Jam: jam,
  PostHog: posthog,
  Sentry: sentry,
} satisfies Record<string, Lookup>;
export type EvidenceSource = keyof typeof EVIDENCE_SOURCES;
/** The order the ticket lists them in. */
export const SOURCE_ORDER: readonly EvidenceSource[] = [
  "Browser",
  "Sentry",
  "Axiom",
  "Inngest",
  "PostHog",
  "Jam",
];

/** Every source at once under one deadline. A failed or slow lookup is reported, never a reason not to file. */
export async function gatherEvidence(
  scope: WidgetContext,
  turn: BugReportTurn,
  runId: string,
  sources: Record<EvidenceSource, Lookup> = EVIDENCE_SOURCES
): Promise<Record<EvidenceSource, Evidence>> {
  const signal = AbortSignal.timeout(EVIDENCE_MS);
  const ctx = appTicketContext(
    {
      ...scope,
      ...(turn.recording ? { recordingId: turn.recording.id } : {}),
      ...(turn.reportedAt
        ? { bugReportedAt: new Date(turn.reportedAt).toISOString() }
        : {}),
    },
    signal,
    runId
  );
  const entries = await Promise.all(
    SOURCE_ORDER.map(async (source) => {
      try {
        return [source, await sources[source](ctx, scope, turn)] as const;
      } catch {
        logOpsEvent("widget.bug_report.evidence_failed", {
          conversationId: scope.conversationId,
          runId,
          tool: source,
        });
        return [
          source,
          {
            reason: signal.aborted
              ? "the lookup timed out"
              : "the lookup failed",
            status: "unchecked",
          },
        ] as const;
      }
    })
  );
  return Object.fromEntries(entries) as Record<EvidenceSource, Evidence>;
}
