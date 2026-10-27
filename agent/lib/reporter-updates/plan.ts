import type { NotFixedReason, Stage } from "./copy.js";

export const DEPLOY_REPOSITORY = "Acquisity/Acquisity";

export interface ClosingComment {
  author: "foreman" | "person";
  body: string;
  createdAt: string;
}

export interface TicketFacts {
  assignee: string | null;
  channel: string | null;
  closingComments: ClosingComment[];
  createdAt: string;
  description: string;
  duplicateOf: string | null;
  identifier: string;
  labels: string[];
  parent: { identifier: string; stateType: string } | null;
  pullUrls: string[];
  stateName: string;
  stateType: string;
  title: string;
}

export type Closure =
  | { kind: "open" }
  | { kind: "not_fixed"; reason: NotFixedReason }
  | { kind: "needs_deploy"; pullUrls: string[] }
  | { kind: "done_without_pull" };

export interface PullFacts {
  body: string;
  mergeSha: string | null;
  number: number;
  repo: string;
  state: "closed" | "merged" | "open";
  title: string;
}

export type DeployVerdict = "held" | "live" | "unsupported" | "waiting";

export type ChangeKind = "bug" | "feature";

export interface Planned {
  covers: Stage[];
  stage: Stage;
  text: string;
}

const NO_CODE_LABELS = new Set(["User Error", "Platform Limitation"]);
const FEATURE_LABEL = "Feature Request";
const BUG_LABEL = "Bug";
const FEATURE_TITLE = /^feat\b/iu;

const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/u;

export const parsePullUrl = (
  url: string
): { number: number; repo: string } | null => {
  const match = PULL_URL.exec(url.trim());
  return match?.[1] && match[2]
    ? { number: Number(match[2]), repo: match[1] }
    : null;
};

export const isTerminal = (stateType: string): boolean =>
  stateType === "completed" || stateType === "canceled";

const hasNoCodeLabel = (facts: TicketFacts): boolean =>
  facts.labels.some((label) => NO_CODE_LABELS.has(label));

export const closureOf = (facts: TicketFacts): Closure => {
  if (facts.stateType === "canceled") {
    if (facts.stateName === "Duplicate") {
      return { kind: "not_fixed", reason: "duplicate" };
    }
    return {
      kind: "not_fixed",
      reason: hasNoCodeLabel(facts) ? "not_a_bug" : "closed",
    };
  }
  const done =
    facts.stateType === "completed" || facts.parent?.stateType === "completed";
  if (!done) {
    return { kind: "open" };
  }
  if (facts.pullUrls.length > 0) {
    return { kind: "needs_deploy", pullUrls: facts.pullUrls };
  }
  if (hasNoCodeLabel(facts)) {
    return { kind: "not_fixed", reason: "not_a_bug" };
  }
  return { kind: "done_without_pull" };
};

export const changeKindOf = (
  labels: readonly string[],
  pulls: readonly PullFacts[]
): ChangeKind => {
  if (labels.includes(FEATURE_LABEL)) {
    return "feature";
  }
  if (labels.includes(BUG_LABEL)) {
    return "bug";
  }
  return pulls.some(
    (pull) => pull.state === "merged" && FEATURE_TITLE.test(pull.title.trim())
  )
    ? "feature"
    : "bug";
};

export const deployVerdict = (
  pulls: readonly PullFacts[],
  liveSha: string | null,
  isAncestor: ReadonlyMap<string, boolean>
): DeployVerdict => {
  const counted = pulls.filter((pull) => pull.state !== "closed");
  if (counted.length === 0) {
    return "held";
  }
  if (counted.some((pull) => pull.repo !== DEPLOY_REPOSITORY)) {
    return "unsupported";
  }
  if (liveSha === null || counted.some((pull) => pull.state === "open")) {
    return "waiting";
  }
  return counted.every(
    (pull) => pull.mergeSha !== null && isAncestor.get(pull.mergeSha) === true
  )
    ? "live"
    : "waiting";
};

const SECTION_HEADING = /^#{2}\s+(.+?)\s*$/u;
const FENCE = /```[\s\S]*?```/gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const HTML_TAG = /<[^>]+>/gu;
const PULL_SECTIONS = new Set(["solution", "how it works"]);
export const MAX_PULL_CONTEXT_CHARS = 3000;

/** The Solution and How it works sections of a pull request description, with code, diagrams and markup removed. */
export const pullContext = (body: string): string => {
  const lines = body
    .replace(FENCE, "")
    .replace(HTML_COMMENT, "")
    .replace(HTML_TAG, "")
    .split("\n");
  const kept: string[] = [];
  let keep = false;
  for (const line of lines) {
    const heading = SECTION_HEADING.exec(line);
    if (heading?.[1]) {
      keep = PULL_SECTIONS.has(heading[1].toLowerCase());
    }
    if (keep) {
      kept.push(line);
    }
  }
  return kept.join("\n").trim().slice(0, MAX_PULL_CONTEXT_CHARS);
};
