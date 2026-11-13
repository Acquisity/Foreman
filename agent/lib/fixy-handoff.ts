import { createHash } from "node:crypto";
import { isAskFromTitle } from "./linear-context.js";

/**
 * FIXY_TRIAGE_TEAMS must match Fixy's FIXY_LINEAR_TEAMS, because Fixy only
 * starts runs on teams it allows.
 */

/** Fixy's Linear app user, the author of each run's final reply on a ticket. */
export const FIXY_LINEAR_USER_ID = "110978d6-72e7-4d4c-8d87-ffe3df9794cc";

const TEAM_KEY = /^[A-Z][A-Z0-9]{1,9}$/u;
const ISSUE_IDENTIFIER = /^([A-Z][A-Z0-9]{1,9})-\d{1,9}$/u;
const TEAMS_MAX_CHARS = 1000;

/** The Linear team keys whose reports go to Fixy; empty means the front door is off. */
export const fixyTriageTeams = (
  env: NodeJS.ProcessEnv = process.env
): ReadonlySet<string> =>
  new Set(
    (env.FIXY_TRIAGE_TEAMS ?? "")
      .slice(0, TEAMS_MAX_CHARS)
      .split(",")
      .map((key) => key.trim().toUpperCase())
      .filter((key) => TEAM_KEY.test(key))
  );

export const issueTeamKey = (identifier: string): string | null =>
  identifier.length <= 32
    ? (ISSUE_IDENTIFIER.exec(identifier.trim().toUpperCase())?.[1] ?? null)
    : null;

export const isFixyTriageTeam = (
  key: string,
  env: NodeJS.ProcessEnv = process.env
): boolean => fixyTriageTeams(env).has(key.trim().toUpperCase());

export const isFixyTriageIssue = (
  identifier: string,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const key = issueTeamKey(identifier);
  return key !== null && isFixyTriageTeam(key, env);
};

const SLACK_TS = /^(\d{10})\.(\d{6})$/u;
const SLACK_PERMALINK_TS = /^p(\d{10})(\d{6})$/u;
const URL_MAX_CHARS = 2048;

/**
 * When a Slack thread started, from its permalink: the `thread_ts` parameter
 * when present (a reply's permalink), else the `p<seconds><micros>` segment.
 * ISO 8601 UTC, kept to the millisecond (microseconds are truncated).
 */
export const reportedAtFromSlackUrl = (url: string): string | null => {
  if (url.length > URL_MAX_CHARS) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    !(parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com"))
  ) {
    return null;
  }
  const match =
    SLACK_TS.exec(parsed.searchParams.get("thread_ts") ?? "") ??
    SLACK_PERMALINK_TS.exec(parsed.pathname.split("/").at(-1) ?? "");
  if (!match) {
    return null;
  }
  const [, seconds, micros] = match;
  const at = new Date(
    Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)
  );
  return at.toISOString();
};

/** The label whose addition starts a Fixy run; Bug starts nothing. */
export const FIXY_LABEL = "fixy";

/** The work lanes a handoff can carry; each is the Linear label `lane:<name>`. */
export const FIXY_LANES = ["billing", "unblock", "eng", "question"] as const;
export type FixyLane = (typeof FIXY_LANES)[number];
export const laneLabel = (lane: FixyLane): string => `lane:${lane}`;

/** What a billing decision on a Fixy ticket carries; no playbook cards exist yet (ENG-18834). */
export const FIXY_BILLING_HANDOFF = {
  card: null,
  handTo: "fixy",
  lane: "billing",
} as const;

export const HANDOFF_HEADING = "## Fixy handoff";
export const FIELD_MAX_CHARS = 500;
export const STEP_MAX_CHARS = 300;
export const REASON_MAX_CHARS = 200;
export const SOURCE_MAX_CHARS = 120;
export const MAX_STEPS = 10;
const BODY_MAX_CHARS = 20_000;

// Characters that would start Markdown or HTML structure inside one value.
const MARKDOWN_CONTROL = /[`*#<>[\]|~\\]/gu;

/** One line of model text: no line breaks or Markdown control characters, bounded. */
export const oneLine = (text: string, max: number): string =>
  text
    .slice(0, max * 4)
    .replace(MARKDOWN_CONTROL, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max)
    .trim();

export const SLACK_THREAD_START = "Slack thread start";
export const TICKET_CREATED = "ticket created; original report time not found";

/**
 * The original report time: the first 'Ask from' link that parses, then the
 * time the caller gave with its source, then ticket creation, labelled so.
 */
export const resolveReportedAt = (
  attachments: readonly { title: string; url: string }[],
  given: { at?: string; source?: string },
  createdAt: string
): { at: string; source: string } => {
  for (const { title, url } of attachments) {
    if (isAskFromTitle(title)) {
      const at = reportedAtFromSlackUrl(url);
      if (at) {
        return { at, source: SLACK_THREAD_START };
      }
    }
  }
  const at = given.at ? Date.parse(given.at) : Number.NaN;
  const source = given.source ? oneLine(given.source, SOURCE_MAX_CHARS) : "";
  if (Number.isFinite(at) && source) {
    return { at: new Date(at).toISOString(), source };
  }
  return { at: new Date(createdAt).toISOString(), source: TICKET_CREATED };
};

const VARIANTS = "89ab";

/**
 * The handoff comment's fixed id, derived from the issue's UUID so it holds
 * across a team move, and so a retry updates the comment instead of posting
 * a second one. The same UUID shape as the reporter-update comment ids.
 */
export const fixyHandoffCommentId = (issueId: string): string => {
  const hex = createHash("sha256")
    .update(`fixy-handoff:${issueId}`)
    .digest("hex");
  const variant = VARIANTS[Number.parseInt(hex.slice(16, 17), 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** What the handoff comment records; exactly one of workspaceId and workspaceUnknown. */
export interface FixyHandoff {
  expected: string;
  /** Empty only on a handoff written before lanes existed. */
  lanes: FixyLane[];
  notes: string | null;
  reportedAt: string;
  reportedAtSource: string;
  steps: string[];
  whatHappened: string;
  workspaceId: string | null;
  workspaceUnknown: string | null;
}

/** The handoff in its stored shape. Values are sanitised here, whoever wrote them. */
export const renderFixyHandoff = (handoff: FixyHandoff): string => {
  const workspace = handoff.workspaceId
    ? oneLine(handoff.workspaceId, 64)
    : `unknown (${oneLine(handoff.workspaceUnknown ?? "", REASON_MAX_CHARS) || "not found"})`;
  const steps = handoff.steps
    .map((step) => oneLine(step, STEP_MAX_CHARS))
    .filter(Boolean)
    .slice(0, MAX_STEPS);
  const notes = handoff.notes ? oneLine(handoff.notes, FIELD_MAX_CHARS) : "";
  return [
    HANDOFF_HEADING,
    "",
    `Workspace ID: ${workspace}`,
    `Reported at: ${handoff.reportedAt} (${oneLine(handoff.reportedAtSource, SOURCE_MAX_CHARS)})`,
    `What happened: ${oneLine(handoff.whatHappened, FIELD_MAX_CHARS)}`,
    `Expected: ${oneLine(handoff.expected, FIELD_MAX_CHARS)}`,
    `Lanes: ${handoff.lanes.join(", ")}`,
    // No playbook cards exist yet (ENG-18834).
    "Card: none",
    "",
    "Steps to reproduce:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...(notes ? ["", `Notes: ${notes}`] : []),
  ].join("\n");
};

const WORKSPACE_ID =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const WORKSPACE_UNKNOWN = /^unknown \((.{0,200})\)$/u;
const REPORTED_AT =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z) \((.{1,120})\)$/u;
const STEP = /^(\d{1,2})\. (.{1,300})$/u;

const isLane = (value: string): value is FixyLane =>
  (FIXY_LANES as readonly string[]).includes(value);

/** Steps are needed for an eng fix, and on a handoff written before lanes. */
export const needsSteps = (lanes: readonly FixyLane[]): boolean =>
  lanes.length === 0 || lanes.includes("eng");

/** Keep earlier lanes and steps when a follow-up adds work without new steps. */
export const mergeHandoffWork = (
  previous: FixyHandoff | null,
  lanes: FixyLane[],
  steps: string[]
): Pick<FixyHandoff, "lanes" | "steps"> => {
  const merged = [...new Set([...lanes, ...(previous?.lanes ?? [])])];
  return {
    lanes: merged,
    steps: steps.length > 0 ? steps : (previous?.steps ?? []),
  };
};

const field = (lines: readonly string[], label: string): string | null => {
  const prefix = `${label}: `;
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length);
};

export const parseFixyHandoff = (body: string): FixyHandoff | null => {
  if (body.length > BODY_MAX_CHARS) {
    return null;
  }
  const lines = body.replace(/\r\n?/gu, "\n").trim().split("\n");
  if (lines[0] !== HANDOFF_HEADING) {
    return null;
  }
  const workspace = field(lines, "Workspace ID");
  const reported = REPORTED_AT.exec(field(lines, "Reported at") ?? "");
  const whatHappened = field(lines, "What happened");
  const expected = field(lines, "Expected");
  const start = lines.indexOf("Steps to reproduce:");
  if (!(workspace && reported && whatHappened && expected) || start < 0) {
    return null;
  }
  const laneLine = field(lines, "Lanes");
  const lanes = laneLine ? laneLine.split(", ") : [];
  if (laneLine === "" || !lanes.every(isLane)) {
    return null;
  }
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const step = STEP.exec(line);
    if (!step || Number(step[1]) !== steps.length + 1) {
      break;
    }
    steps.push(step[2]);
  }
  const id = WORKSPACE_ID.exec(workspace)?.[1] ?? null;
  const unknown = id ? null : (WORKSPACE_UNKNOWN.exec(workspace)?.[1] ?? null);
  if (!(id || unknown !== null) || (steps.length === 0 && needsSteps(lanes))) {
    return null;
  }
  return {
    expected,
    lanes,
    notes: field(lines.slice(start + 1 + steps.length), "Notes"),
    reportedAt: reported[1],
    reportedAtSource: reported[2],
    steps,
    whatHappened,
    workspaceId: id,
    workspaceUnknown: unknown,
  };
};
