import { gateway, generateObject, generateText } from "ai";
import { z } from "zod";
import { gatewayRouting, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  type IdentifierCandidates,
  type OwnedIdentifiers,
  resolveOwnedIdentifiers,
} from "./widget-evidence.js";
import type { WidgetFindings } from "./widget-findings.js";
import type { WidgetContext } from "./widget-scope.js";

export type GateDecision = "allow" | "rewrite" | "block";
export interface GateResult {
  decision: GateDecision;
  findings: WidgetFindings;
  message: string | null;
  reason: string;
  /** Milliseconds spent in each gate step, for the finish timing log. */
  timings?: Record<string, number>;
}
export interface GateDeps {
  compose: (input: {
    findings: ComposerInput;
    organizationName: string;
    question: string;
  }) => Promise<string>;
  judge: (input: {
    findings: WidgetFindings;
    /** The customer-visible parts of the findings, numbered for `remove`. */
    items: RedactableItem[];
    question: string;
    scope: WidgetContext;
  }) => Promise<{ decision: GateDecision; reason: string; remove?: number[] }>;
  resolve: (
    scope: WidgetContext,
    candidates: IdentifierCandidates
  ) => Promise<OwnedIdentifiers>;
}

/** The composer never sees evidence references, the CS report, or the internal ticket. */
export type ComposerInput = Omit<
  WidgetFindings,
  "facts" | "report" | "ticket"
> & {
  facts: { claim: string }[];
};

/** People who must never be named to a customer. Fill from config when a name leaks. */
const INTERNAL_NAMES: readonly string[] = [];
const INTERNAL_HOSTS = [
  "sentry.io",
  "inngest.com",
  "axiom.co",
  "vercel.com",
  "vercel.app",
  "slack.com",
  "github.com",
  "linear.app",
  "planetscale.com",
  "neon.tech",
  "upstash.com",
  "resend.com",
  "stripe.com",
  "useautumn.com",
  "intercom.com",
];
const PUBLIC_HOSTS = new Set([
  "acquisity.ai",
  "app.acquisity.ai",
  "help.acquisity.ai",
  "docs.acquisity.ai",
]);
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s)>"']+/gi;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const WORKSPACE_PATH = /\/dashboard\/([^/\s?#]+)/g;
const STACK_TRACE = /\n\s+at\s+\S.*:\d+(?::\d+)?\)?/;
const LINEAR_REF = /\bENG-\d+\b/g;
/** Inngest run ids are ULIDs; Vercel, Stripe and Sentry ids carry stable prefixes. */
const OPS_IDS =
  /\b(?:01[0-9A-HJKMNP-TV-Z]{24}|dpl_[A-Za-z0-9]{8,}|(?:cus|sub|in|ch|pi|re|dp|evt|prod|price)_[A-Za-z0-9]{8,})\b/g;

const uniqueLower = (matches: RegExpMatchArray | string[] | null) =>
  Array.from(new Set((matches ?? []).map((value) => value.toLowerCase())));

export function customerText(findings: WidgetFindings): string {
  return [
    ...findings.facts.flatMap((fact) => [fact.claim, ...fact.entityIds]),
    findings.recommendation,
    findings.needsWrite ?? "",
  ].join("\n");
}

/** Everything identifier-shaped in an arbitrary customer-bound string. */
export function scanIdentifiers(
  text: string,
  exemptTicketId?: string
): {
  candidates: IdentifierCandidates;
  internal: string[];
} {
  const internal: string[] = [];
  const urls = text.match(URL_PATTERN) ?? [];
  const slugs = new Set<string>();
  for (const value of urls) {
    const url = URL.parse(value);
    const host = url?.hostname.toLowerCase() ?? "";
    if (INTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      internal.push(value);
    }
    for (const match of value.matchAll(WORKSPACE_PATH)) {
      slugs.add(match[1].toLowerCase());
    }
  }
  const emails = uniqueLower(text.match(EMAIL));
  const emailDomains = new Set(emails.map((email) => email.split("@")[1]));
  for (const domain of uniqueLower(text.match(DOMAIN))) {
    if (
      !(
        PUBLIC_HOSTS.has(domain) ||
        emailDomains.has(domain) ||
        urls.some((value) => value.toLowerCase().includes(domain))
      )
    ) {
      internal.push(domain);
    }
  }
  if (STACK_TRACE.test(text)) {
    internal.push("stack trace");
  }
  for (const id of uniqueLower(text.match(OPS_IDS))) {
    internal.push(id);
  }
  for (const ref of new Set(text.match(LINEAR_REF) ?? [])) {
    if (ref !== exemptTicketId) {
      internal.push(ref);
    }
  }
  for (const name of INTERNAL_NAMES) {
    if (text.toLowerCase().includes(name.toLowerCase())) {
      internal.push(name);
    }
  }
  return {
    candidates: {
      emails,
      slugs: Array.from(slugs),
      uuids: uniqueLower(text.match(UUID)),
    },
    internal,
  };
}

/** Everything identifier-shaped in the findings the composer could ever see. */
export function extractIdentifiers(findings: WidgetFindings): {
  candidates: IdentifierCandidates;
  internal: string[];
} {
  return scanIdentifiers(customerText(findings), findings.ticket?.id);
}

// The composer never sees the internal ticket: its id and its linear.app URL are
// internal artifacts, and needsWrite/the recommendation already carry any
// follow-up the customer should hear about.
export const composerInput = (findings: WidgetFindings): ComposerInput => ({
  confidence: findings.confidence,
  facts: findings.facts.map((fact) => ({ claim: fact.claim })),
  needsHuman: findings.needsHuman,
  ...(findings.needsWrite ? { needsWrite: findings.needsWrite } : {}),
  recommendation: findings.recommendation,
});

// The deterministic layer owns the cross-tenant guarantee: internal-only
// artifacts and identifiers that do not belong to the verified workspace. Claim
// backing is judged by the model gate below. (A per-fact evidence.ref
// requirement was incompatible with the prose->extract flow, where a small model
// reformats the investigator's write-up and cannot restate a ref per fact even
// though the claim came from a real tool result.)
async function deterministicTextReason(
  scope: WidgetContext,
  text: string,
  resolve: GateDeps["resolve"],
  exemptTicketId?: string
): Promise<string | null> {
  const { candidates, internal } = scanIdentifiers(text, exemptTicketId);
  if (internal.length) {
    return `internal_artifact:${internal[0]}`;
  }
  if (
    candidates.uuids.length +
      candidates.slugs.length +
      candidates.emails.length ===
    0
  ) {
    return null;
  }
  const owned = await resolve(scope, candidates);
  const foreign =
    candidates.uuids.find((id) => !owned.uuids.has(id)) ??
    candidates.slugs.find((slug) => !owned.slugs.has(slug)) ??
    candidates.emails.find((email) => !owned.emails.has(email));
  return foreign ? `foreign_identifier:${foreign}` : null;
}

function deterministicReason(
  scope: WidgetContext,
  findings: WidgetFindings,
  resolve: GateDeps["resolve"]
): Promise<string | null> {
  return deterministicTextReason(
    scope,
    customerText(findings),
    resolve,
    findings.ticket?.id
  );
}

export interface RedactableItem {
  kind: "fact" | "recommendation" | "needsWrite";
  n: number;
  text: string;
}

const SENTENCE = /[^.!?\n]+[.!?]*\s*/gu;
const sentences = (text: string): string[] =>
  (text.match(SENTENCE) ?? []).filter((part) => part.trim());

/**
 * Everything the customer could end up reading, numbered: each fact, each
 * sentence of the recommendation, and the needed change. The report, the
 * ticket and the evidence never reach the composer, so they are not listed.
 */
export function redactableItems(findings: WidgetFindings): RedactableItem[] {
  const items: Omit<RedactableItem, "n">[] = [
    ...findings.facts.map((fact) => ({
      kind: "fact" as const,
      text: fact.claim,
    })),
    ...sentences(findings.recommendation).map((text) => ({
      kind: "recommendation" as const,
      text: text.trim(),
    })),
    ...(findings.needsWrite
      ? [{ kind: "needsWrite" as const, text: findings.needsWrite }]
      : []),
  ];
  return items.map((item, index) => ({ ...item, n: index + 1 }));
}

/**
 * Apply a rewrite by deletion only. The judge names item numbers and this
 * removes them, so a rewrite can drop content but can never add or reword any:
 * whatever survives is text the investigator wrote. Returns null when the
 * numbers are unusable or nothing would be left to tell the customer, and the
 * caller then blocks.
 */
export function removeItems(
  findings: WidgetFindings,
  remove: number[]
): WidgetFindings | null {
  const items = redactableItems(findings);
  const drop = new Set(remove);
  if (
    drop.size === 0 ||
    [...drop].some((n) => !Number.isInteger(n) || n < 1 || n > items.length)
  ) {
    return null;
  }
  const kept = items.filter((item) => !drop.has(item.n));
  const keptFacts = new Set(
    kept.filter((item) => item.kind === "fact").map((item) => item.n)
  );
  const recommendation = kept
    .filter((item) => item.kind === "recommendation")
    .map((item) => item.text)
    .join(" ");
  const facts = findings.facts.filter((_fact, index) =>
    keptFacts.has(index + 1)
  );
  if (facts.length === 0 && !recommendation) {
    return null;
  }
  const { needsWrite, ...rest } = findings;
  return {
    ...rest,
    facts,
    recommendation,
    ...(needsWrite && kept.some((item) => item.kind === "needsWrite")
      ? { needsWrite }
      : {}),
  };
}

// Two false blocks shaped this wording, both measured against the gate model.
// A customer's own campaign named after a person ("James Rea") was read as data
// about another person, and an empty evidence reference was read as an unbacked
// claim, though a separate step reformats the write-up and cannot restate one.
// The same test confirmed another workspace's data, another customer's personal
// details and internal operations detail are all still stopped.
const JUDGE_PROMPT = `You are the egress gate between an internal investigator and a customer of Acquisity. You receive the verified customer scope, the customer's question, and the investigator's findings. Decide whether the findings can be shown to this customer.
Block when any fact or the recommendation discloses data belonging to a different workspace or customer, personal details of an individual who is not part of the verified workspace (another customer, another user's account, an Acquisity employee), or internal operations detail (systems, dashboards, logs, employees, deployments, error traces, tickets other than findings.ticket).
Everything inside the verified workspace is the customer's own data and is safe to show them: their campaigns, lead lists, leads, inboxes, domains, settings and members, and the names of those things. A campaign, list or inbox is often named after a person or a company; such a name is the customer's own label, not data about another person, so never block or rewrite because of it. Evidence references are often empty because a separate step reformats the investigator's write-up; an empty reference is never a reason to block.
Rewrite when removing a few items makes the rest safe: list in "remove" the numbers of the items to delete, using the numbering in "items", and everything you do not list is shown to the customer unchanged. You cannot reword anything, only remove it. Allow when everything is about the verified workspace and its own user, and leave "remove" empty. When you cannot tell whether something belongs to a different workspace or customer, block. The reason is one short sentence for internal staff.`;

const COMPOSER_PROMPT = `You write Acquisity's reply to a customer in the in-app support chat. You receive only gated findings about the customer's own workspace and their question. Write a short, plain, warm reply in the second person that answers the question from the facts, states the recommendation, and says clearly what could not be checked. Never mention internal tools, systems, employees, or how the investigation was done. Never add facts, links, or identifiers that are not in the findings. Never promise that a teammate, the team, support, or you will make a change, look into something later, or follow up: nobody will, so the customer must leave knowing what to do themselves. When a change is needed, give them the steps to make it in the product. If needsWrite is present, treat it as a description of a change that is needed and turn it into steps for the customer, never into a promise. If the customer asked you to make a change for them, apologise in one short sentence, say you are not able to make changes to their account, and then give the steps. If confidence is low, say what is uncertain. No greetings, no sign-off, no em dashes.`;

// The judge returns a verdict and, for a rewrite, the numbers of the items to
// remove. It used to return the findings themselves, and re-emitted every one of
// them on a slow reasoning model: measured at up to 1,300 output tokens on a
// plain allow, and 60 to 90 seconds in production when it rewrote. Numbers are a
// few tokens, and deletion by number is also stricter than a free rewrite.
const verdictSchema = z.object({
  decision: z.enum(["allow", "rewrite", "block"]),
  reason: z.string().max(500),
  remove: z.array(z.number().int()).max(60).optional(),
});

export const defaultGateDeps: GateDeps = {
  async compose({ findings, organizationName, question }) {
    const model = await resolveModel("gate");
    const { text } = await generateText({
      model: gateway(model),
      ...gatewayRouting(model),
      prompt: JSON.stringify({
        findings,
        question,
        workspace: organizationName,
      }),
      system: COMPOSER_PROMPT,
    });
    return text.trim();
  },
  async judge({ findings, items, question, scope }) {
    const model = await resolveModel("gate");
    const { object } = await generateObject({
      model: gateway(model),
      ...gatewayRouting(model),
      prompt: JSON.stringify({
        findings,
        items,
        question,
        scope: {
          organizationId: scope.organizationId,
          organizationName: scope.organizationName,
          organizationSlug: scope.organizationSlug,
          userId: scope.userId,
        },
      }),
      schema: verdictSchema,
      system: JUDGE_PROMPT,
    });
    return object;
  },
  resolve: resolveOwnedIdentifiers,
};

const blocked = (findings: WidgetFindings, reason: string): GateResult => ({
  decision: "block",
  findings,
  message: null,
  reason,
});

/** Deterministic identifier check, then the model gate, then the composer. Every failure blocks. */
export async function gate(
  scope: WidgetContext,
  question: string,
  findings: WidgetFindings,
  deps: GateDeps = defaultGateDeps
): Promise<GateResult> {
  const timings: Record<string, number> = {};
  const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      timings[step] = (timings[step] ?? 0) + Date.now() - startedAt;
    }
  };
  const done = (result: GateResult): GateResult => ({ ...result, timings });
  try {
    const reason = await timed("scan", () =>
      deterministicReason(scope, findings, deps.resolve)
    );
    if (reason) {
      return done(blocked(findings, reason));
    }
    // needsHuman flags the CS inbox; it does not by itself wall off the
    // customer. When Foreman found concrete facts, it answers autonomously and
    // routes any teammate follow-up through needsWrite/the note. Only hand off
    // fully when there is nothing concrete to say (no facts at all).
    if (findings.needsHuman && findings.facts.length === 0) {
      return done(blocked(findings, "needs_human"));
    }
    const verdict = await timed("judge", () =>
      deps.judge({
        findings,
        items: redactableItems(findings),
        question,
        scope,
      })
    );
    if (verdict.decision === "block") {
      return done(blocked(findings, `model_gate:${verdict.reason}`));
    }
    let gated = findings;
    if (verdict.decision === "rewrite") {
      const rewritten = removeItems(findings, verdict.remove ?? []);
      if (!rewritten) {
        return done(blocked(findings, "model_gate:invalid_rewrite"));
      }
      gated = rewritten;
      const again = await timed("scan", () =>
        deterministicReason(scope, gated, deps.resolve)
      );
      if (again) {
        return done(blocked(findings, again));
      }
    }
    const message = await timed("compose", () =>
      deps.compose({
        findings: composerInput(gated),
        organizationName: scope.organizationName,
        question,
      })
    );
    if (!message) {
      return done(blocked(findings, "empty_reply"));
    }
    // Final guarantee: scan the actual customer-bound text. The composer is a
    // model and can introduce an identifier or internal artifact that was never
    // in the gated findings; the customer message must contain no foreign
    // identifier and no ticket reference at all.
    const egress = await timed("scan", () =>
      deterministicTextReason(scope, message, deps.resolve)
    );
    if (egress) {
      return done(blocked(findings, `composed:${egress}`));
    }
    return done({
      decision: verdict.decision,
      findings: gated,
      message,
      reason: verdict.reason,
    });
  } catch (error) {
    // The gate fails closed, but log why: a swallowed error here (a gate-model
    // failure, an ownership-resolution failure) is otherwise invisible and every
    // reply just blocks as "gate_unavailable". The message field is redacted.
    logOpsEvent(
      "widget.egress.gate_error",
      {
        conversationId: scope.conversationId,
        message: error instanceof Error ? error.message : "unknown",
        outcome: "error",
      },
      console.warn
    );
    return done(blocked(findings, "gate_unavailable"));
  }
}

export function logGateDecision(
  fields: { conversationId: string; runId: string; sessionId?: string },
  result: Pick<GateResult, "decision" | "reason">
) {
  logOpsEvent("widget.egress.decision", {
    conversationId: fields.conversationId,
    decision: result.decision,
    message: result.reason,
    runId: fields.runId,
    sessionId: fields.sessionId,
  });
}
