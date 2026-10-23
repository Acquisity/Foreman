import {
  firstName,
  fixedText,
  type NotFixedReason,
  notFixedText,
  ownerText,
  receivedText,
  type Stage,
} from "./copy.js";

export const DEPLOY_REPOSITORY = "Acquisity/Acquisity";

export interface TicketFacts {
  assignee: string | null;
  channel: string | null;
  createdAt: string;
  identifier: string;
  labels: string[];
  parent: { identifier: string; stateType: string } | null;
  pullUrls: string[];
  stateName: string;
  stateType: string;
}

export type Closure =
  | { kind: "open" }
  | { kind: "not_fixed"; reason: NotFixedReason }
  | { kind: "needs_deploy"; pullUrls: string[] }
  | { kind: "held"; why: "no_linked_pull" };

export interface PullFacts {
  mergeSha: string | null;
  number: number;
  repo: string;
  state: "closed" | "merged" | "open";
}

export type DeployVerdict = "held" | "live" | "unsupported" | "waiting";

export interface Planned {
  covers: Stage[];
  stage: Stage;
  text: string;
}

const NO_CODE_LABELS = new Set(["User Error", "Platform Limitation"]);

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

const noCodeReason = (facts: TicketFacts): NotFixedReason =>
  facts.labels.some((label) => NO_CODE_LABELS.has(label))
    ? "not_a_bug"
    : "closed";

export const closureOf = (facts: TicketFacts): Closure => {
  if (facts.stateType === "canceled") {
    return {
      kind: "not_fixed",
      reason:
        facts.stateName === "Duplicate" ? "duplicate" : noCodeReason(facts),
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
  if (facts.labels.includes("Bug") || facts.parent) {
    return { kind: "held", why: "no_linked_pull" };
  }
  return { kind: "not_fixed", reason: noCodeReason(facts) };
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

export const planEarly = (
  facts: TicketFacts,
  done: ReadonlySet<Stage>,
  nameOwner: boolean
): Planned | null => {
  const owner =
    nameOwner && facts.stateType !== "triage"
      ? firstName(facts.assignee)
      : null;
  if (!done.has("received")) {
    return {
      covers:
        owner && !done.has("owner") ? ["received", "owner"] : ["received"],
      stage: "received",
      text: receivedText(owner),
    };
  }
  if (owner && !done.has("owner")) {
    return { covers: ["owner"], stage: "owner", text: ownerText(owner) };
  }
  return null;
};

export const planNotFixed = (reason: NotFixedReason): Planned => ({
  covers: ["not_fixed"],
  stage: "not_fixed",
  text: notFixedText(reason),
});

export const planFixed = (): Planned => ({
  covers: ["fixed"],
  stage: "fixed",
  text: fixedText(),
});
