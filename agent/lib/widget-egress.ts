import { gateway, generateObject, generateText } from "ai";
import { z } from "zod";
import { resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  type IdentifierCandidates,
  type OwnedIdentifiers,
  resolveOwnedIdentifiers,
} from "./widget-evidence.js";
import { findingsSchema, type WidgetFindings } from "./widget-findings.js";
import type { WidgetContext } from "./widget-scope.js";

export type GateDecision = "allow" | "rewrite" | "block";
export interface GateResult {
  decision: GateDecision;
  findings: WidgetFindings;
  message: string | null;
  reason: string;
}
export interface GateDeps {
  compose: (input: {
    findings: ComposerInput;
    organizationName: string;
    question: string;
  }) => Promise<string>;
  judge: (input: {
    findings: WidgetFindings;
    question: string;
    scope: WidgetContext;
  }) => Promise<{ decision: GateDecision; findings?: unknown; reason: string }>;
  resolve: (
    scope: WidgetContext,
    candidates: IdentifierCandidates
  ) => Promise<OwnedIdentifiers>;
}

/** The composer never sees evidence references: those name internal tools and records. */
export type ComposerInput = Omit<WidgetFindings, "facts"> & {
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

/** Everything identifier-shaped in the text the composer could ever see. */
export function extractIdentifiers(findings: WidgetFindings): {
  candidates: IdentifierCandidates;
  internal: string[];
} {
  const text = customerText(findings);
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
    if (ref !== findings.ticket?.id) {
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

export const composerInput = (findings: WidgetFindings): ComposerInput => ({
  confidence: findings.confidence,
  facts: findings.facts.map((fact) => ({ claim: fact.claim })),
  needsHuman: findings.needsHuman,
  ...(findings.needsWrite ? { needsWrite: findings.needsWrite } : {}),
  recommendation: findings.recommendation,
  ...(findings.ticket ? { ticket: findings.ticket } : {}),
});

async function deterministicReason(
  scope: WidgetContext,
  findings: WidgetFindings,
  resolve: GateDeps["resolve"]
): Promise<string | null> {
  if (findings.facts.some((fact) => !fact.evidence.ref.trim())) {
    return "unbacked_claim";
  }
  const { candidates, internal } = extractIdentifiers(findings);
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

const JUDGE_PROMPT = `You are the egress gate between an internal investigator and a customer of Acquisity. You receive the verified customer scope, the customer's question, and the investigator's findings. Decide whether the findings can be shown to this customer.
Block when any fact or the recommendation mentions data about another workspace or another person, internal operations detail (systems, dashboards, logs, employees, deployments, error traces, tickets other than findings.ticket), or a claim that is not clearly backed by its evidence reference. Rewrite when removing a few sentences makes the rest safe: return the redacted findings with the same shape. Allow when everything is about the verified workspace and its own user. When unsure, block. The reason is one short sentence for internal staff.`;

const COMPOSER_PROMPT = `You write Acquisity's reply to a customer in the in-app support chat. You receive only gated findings about the customer's own workspace and their question. Write a short, plain, warm reply in the second person that answers the question from the facts, states the recommendation, and says clearly what could not be checked. Never mention internal tools, systems, employees, or how the investigation was done. Never add facts, links, or identifiers that are not in the findings. If needsWrite is present, tell the customer a teammate will make that change. If confidence is low, say what is uncertain. No greetings, no sign-off, no em dashes.`;

const judgeSchema = z.object({
  decision: z.enum(["allow", "rewrite", "block"]),
  findings: findingsSchema.optional(),
  reason: z.string().max(500),
});

export const defaultGateDeps: GateDeps = {
  async compose({ findings, organizationName, question }) {
    const { text } = await generateText({
      model: gateway(await resolveModel("gate")),
      prompt: JSON.stringify({
        findings,
        question,
        workspace: organizationName,
      }),
      system: COMPOSER_PROMPT,
    });
    return text.trim();
  },
  async judge({ findings, question, scope }) {
    const { object } = await generateObject({
      model: gateway(await resolveModel("gate")),
      prompt: JSON.stringify({
        findings,
        question,
        scope: {
          organizationId: scope.organizationId,
          organizationName: scope.organizationName,
          organizationSlug: scope.organizationSlug,
          userId: scope.userId,
        },
      }),
      schema: judgeSchema,
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
  try {
    const reason = await deterministicReason(scope, findings, deps.resolve);
    if (reason) {
      return blocked(findings, reason);
    }
    if (findings.needsHuman) {
      return blocked(findings, "needs_human");
    }
    const verdict = await deps.judge({ findings, question, scope });
    if (verdict.decision === "block") {
      return blocked(findings, `model_gate:${verdict.reason}`);
    }
    let gated = findings;
    if (verdict.decision === "rewrite") {
      const rewritten = findingsSchema.safeParse(verdict.findings);
      if (!rewritten.success) {
        return blocked(findings, "model_gate:invalid_rewrite");
      }
      gated = rewritten.data;
      const again = await deterministicReason(scope, gated, deps.resolve);
      if (again) {
        return blocked(findings, again);
      }
    }
    const message = await deps.compose({
      findings: composerInput(gated),
      organizationName: scope.organizationName,
      question,
    });
    if (!message) {
      return blocked(findings, "empty_reply");
    }
    return {
      decision: verdict.decision,
      findings: gated,
      message,
      reason: verdict.reason,
    };
  } catch {
    return blocked(findings, "gate_unavailable");
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
