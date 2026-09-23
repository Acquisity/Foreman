import { gateway, generateObject, generateText } from "ai";
import { z } from "zod";
import { fastCallOptions, gatewayRouting, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  type IdentifierCandidates,
  type OwnedIdentifiers,
  resolveOwnedIdentifiers,
} from "./widget-evidence.js";
import type { WidgetFindings } from "./widget-findings.js";
import { LIMITATION_POLICY, reviewWidgetFindings } from "./widget-review.js";
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
    /** Jev read the conversation as a request to change something on the account. */
    askedForChange?: boolean;
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

/** The composer never sees evidence references, the CS report, or the internal ticket: only whether one was filed. */
export type ComposerInput = Omit<
  WidgetFindings,
  "facts" | "report" | "ticket"
> & {
  facts: { claim: string }[];
  ticketFiled?: true;
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
const FOREIGN_PREFIX = "foreign_identifier:";
/** How many foreign identifiers the gate deletes items for before it gives up and blocks. */
const MAX_FOREIGN_PASSES = 5;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s)>"']+/gi;
const DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
// A website fix names the file that broke ("calendar.tsx", "next.config.js"). These
// endings are not registrable domains, so such a name is never another tenant's
// domain; treating it as one deleted the fix from the reply.
const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|s?css|json|html?)$/u;
const WORKSPACE_PATH = /\/dashboard\/([^/\s?#]+)/g;
const STACK_TRACE = /\n\s+at\s+\S.*:\d+(?::\d+)?\)?/;
const LINEAR_REF = /\bENG-\d+\b/g;
/** Inngest run ids are ULIDs; Vercel, Stripe and Sentry ids carry stable prefixes. */
const OPS_IDS =
  /\b(?:01[0-9A-HJKMNP-TV-Z]{24}|dpl_[A-Za-z0-9]{8,}|(?:cus|sub|in|ch|pi|re|dp|evt|prod|price)_[A-Za-z0-9]{8,})\b/g;

const uniqueLower = (matches: RegExpMatchArray | string[] | null) =>
  Array.from(new Set((matches ?? []).map((value) => value.toLowerCase())));

const OPS_ID_ONLY = new RegExp(`^(?:${OPS_IDS.source})$`);

/** A fact's identifier that is a ticket number and nothing else: the composer never sees it, so it cannot leak from there. */
const TICKET_ID_ONLY = /^ENG-\d+$/u;

// entityIds exist so the ownership check can vouch for them; the composer never
// sees them. An outside-service id (Stripe cus_, a run id) or a ticket number cannot be vouched for
// and cannot leak from here, so it is left out instead of blocking a safe
// answer. The same id inside a claim, the recommendation or the composed reply
// still blocks.
export function customerText(findings: WidgetFindings): string {
  return [
    ...findings.facts.flatMap((fact) => [
      fact.claim,
      ...fact.entityIds.filter(
        (id) => !(OPS_ID_ONLY.test(id.trim()) || TICKET_ID_ONLY.test(id.trim()))
      ),
    ]),
    findings.recommendation,
    findings.needsWrite ?? "",
  ].join("\n");
}

const isInternalHost = (host: string) =>
  INTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * A bare domain is either one of ours (internal, always blocked) or something
 * the ownership check must vouch for, such as the customer's own sending domain.
 * One it cannot vouch for is foreign and blocks, as it always did. Domains that
 * are public, part of a url, or the domain of an email already in the text are
 * covered by those checks and skipped here.
 */
function classifyDomains(
  text: string,
  urls: string[],
  emailDomains: Set<string>,
  internal: string[]
): string[] {
  const domains: string[] = [];
  for (const domain of uniqueLower(text.match(DOMAIN))) {
    const covered =
      SOURCE_FILE.test(domain) ||
      PUBLIC_HOSTS.has(domain) ||
      emailDomains.has(domain) ||
      urls.some((value) => value.toLowerCase().includes(domain));
    if (covered) {
      continue;
    }
    if (isInternalHost(domain)) {
      internal.push(domain);
    } else {
      domains.push(domain);
    }
  }
  return domains;
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
    if (isInternalHost(host)) {
      internal.push(value);
    }
    for (const match of value.matchAll(WORKSPACE_PATH)) {
      slugs.add(match[1].toLowerCase());
    }
  }
  const emails = uniqueLower(text.match(EMAIL));
  const emailDomains = new Set(emails.map((email) => email.split("@")[1]));
  const domains = classifyDomains(text, urls, emailDomains, internal);
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
      domains,
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
// internal artifacts. It is told only that one was filed, so a customer who asked
// for a ticket is not told it could not be done.
export const composerInput = (findings: WidgetFindings): ComposerInput => ({
  confidence: findings.confidence,
  facts: findings.facts.map((fact) => ({ claim: fact.claim })),
  needsHuman: findings.needsHuman,
  ...(findings.needsWrite ? { needsWrite: findings.needsWrite } : {}),
  recommendation: findings.recommendation,
  ...(findings.ticket ? { ticketFiled: true as const } : {}),
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
  const domains = candidates.domains ?? [];
  if (
    candidates.uuids.length +
      candidates.slugs.length +
      candidates.emails.length +
      domains.length ===
    0
  ) {
    return null;
  }
  const owned = await resolve(scope, candidates);
  const foreign =
    candidates.uuids.find((id) => !owned.uuids.has(id)) ??
    candidates.slugs.find((slug) => !owned.slugs.has(slug)) ??
    candidates.emails.find((email) => !owned.emails.has(email)) ??
    domains.find((domain) => !owned.domains.has(domain));
  return foreign ? `${FOREIGN_PREFIX}${foreign}` : null;
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

// A full stop ends a sentence only before whitespace, so a domain, an email or a
// version number stays inside one item and can be removed with it.
// The same goes for the full stop of a list marker ("2. Filter by..."): a bare
// "2." became its own item, was reviewed as a claim, and was deleted on its own.
const SENTENCE =
  /(?:[^.!?\n]|[.!?](?=\S)|(?<=(?:^|\s)\d{1,2})\.(?=\s+\S))+[.!?]*\s*/gu;
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

// ponytail: a word list, not understanding. It misses a caveat phrased another
// way (the reviewers' policy is the first defence) and can count a non-caveat,
// which only costs an extra block. Upgrade path: a structured caveat flag on facts.
const CAVEAT =
  /\b(?:cannot|can(?:'|’)t|could(?: not|n(?:'|’)t)|unable|unknown|uncertain|unconfirmed|unverified|unavailable|not (?:be |been |yet )?(?:confirmed|verified|checked|established|settled|known|readable|available)|does not (?:establish|show|prove|mean))\b/iu;

/**
 * Looks at the answer that would remain, not at each deletion: findings that
 * said something was unconfirmed must still say so afterwards. Whoever asked
 * for the deletions, an answer stripped of its last caveat claims more than was
 * verified, so it is refused and the caller blocks.
 */
export const removesLastCaveat = (
  before: { text: string }[],
  kept: { text: string }[]
): boolean =>
  before.some((item) => CAVEAT.test(item.text)) &&
  !kept.some((item) => CAVEAT.test(item.text));

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
  if (
    (facts.length === 0 && !recommendation) ||
    removesLastCaveat(items, kept)
  ) {
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
Everything inside the verified workspace is the customer's own data and is safe to show them: their campaigns, lead lists, leads, inboxes, domains, settings and members, and the names of those things. A campaign, list or inbox is often named after a person or a company; such a name is the customer's own label, not data about another person, so never block or rewrite because of it. Evidence references are often empty because a separate step reformats the investigator's write-up; an empty reference is never a reason to block. Naming Stripe for the customer's own billing, or Instantly for their own sending accounts, is not internal operations detail. Remove an item whose point is what another outside service (such as Autumn, Sentry, Axiom, Inngest, Vercel) shows or did; an item that merely names one while stating a fact about the customer's workspace can stay, because the reply writer drops the name.
${LIMITATION_POLICY}
Also remove an item that tells the customer to buy again, place a new order or pay again while the findings leave the original payment or delivery unresolved, and an item that promises sending or other activity will resume.
Rewrite when removing a few items makes the rest safe: list in "remove" the numbers of the items to delete, using the numbering in "items", and everything you do not list is shown to the customer unchanged. You cannot reword anything, only remove it. Allow when everything is about the verified workspace and its own user, and leave "remove" empty. When you cannot tell whether something belongs to a different workspace or customer, block. The reason is one short sentence for internal staff.`;

const COMPOSER_PROMPT = `You write Acquisity's reply to a customer in the in-app support chat. You receive only gated findings about the customer's own workspace and their question. Write a short, plain, warm reply in the second person that answers the question from the facts, states the recommendation, and says clearly what could not be checked. Never mention internal tools, systems, employees, or how the investigation was done. Speak in Acquisity product terms and do not name the outside services behind the product (billing and credit systems, error tracking, logs, job runners, hosting, databases): say "your credits", "your billing", "your sending accounts", not the vendor. Two exceptions: Stripe may be named for billing, since the customer sees it under Manage billing; Instantly may be named only when the findings already name it, otherwise say "your sending accounts" or "your inboxes". Never add facts, links, or identifiers that are not in the findings. A READY deployment is not proof that a website works or is publicly live. Incomplete provisioning is not proof it never started. A missing execution-run reference is not proof that no run exists or that no run started. A timezone hypothesis is not a confirmed cause. Keep uncertainty specific to the missing check: an unknown edit history or propagation state does not mean observed public DNS could not be verified. Never turn an omitted fact into a claim that its check failed or could not be performed. Keep the certainty the findings have: never turn saved settings into live health, inactive into missing, or an unconfirmed payment into a paid order, never say that sending or other activity will resume, and never suggest buying again or placing a new order unless the recommendation says to. Never add a product step the findings do not give. No recorded problem is not proof that nothing is wrong: never say that nothing needs changing, that no action is needed or that everything is fine unless a fact says a live check showed it; say that no problem was recorded, and what could not be checked. Never promise that a teammate, the team, support, or you will make a change, look into something later, or follow up: nobody will, so the customer must leave knowing what to do themselves. When a change is needed, give only the article-backed steps already present in the findings. If needsWrite is present, it describes a needed change, not instructions for carrying it out; never invent steps from it. When the findings lack applicable instructions, acknowledge that gap. If askedForChange is true, the customer asked you to make a change for them: apologise in one short sentence, say you are not able to make changes to their account, and then give the steps. If askedForChange is false, never say you cannot make changes to their account or apologise for something they did not ask for. Filing a ticket is the one thing that may have been done for them: when ticketFiled is true, say in one short sentence that you have reported this to the engineering team as a ticket, without a ticket number, a link, a timeline or a promise of a follow-up, and never say you cannot open a ticket; then still give the customer what they can do themselves. When the customer asked for a ticket and ticketFiled is absent, never say a ticket cannot be opened and never refuse: say in one short sentence that you want to pin down what is going wrong first so engineering gets something they can act on, then ask for the specific details the findings say are missing or give the fix to try, and say you will report it to engineering if that shows a fault on our side; this is the one allowed exception to the rule against promises, because it happens in this chat when they reply, not later. If confidence is low, say what is uncertain. This chat is text only: the customer cannot attach or upload a file, image or screenshot here, so never ask for one; ask them to describe what they see or paste the exact error text. The question may come with the earlier turns of the conversation: you are continuing that conversation, not starting a new one. Never repeat a fact, a step or a warning that Support already said earlier unless it has changed. When the customer is reporting what they saw or did (for example that something shows as connected, or that a step is done), acknowledge it in a few words, accept it as true, and move them to the next thing to check or do; do not re-explain the original problem. When the way forward is troubleshooting, give the next one or two things to check, not the whole list, and ask what they see so you can guide them from there. When the findings give a message for the customer to paste into the website builder's chat, the customer cannot fix code themselves and cannot see build logs: say in one plain sentence what broke, tell them to open the website in the builder and paste the message into its chat, then give that message on its own line in quotation marks, keeping any file name and error wording it contains, and tell them to publish again once the builder finishes. Never tell them to fix code, check a build log or find an error themselves. No greetings, no sign-off, no em dashes.`;

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

type JudgeInput = Parameters<GateDeps["judge"]>[0];

/** The existing model reviewer; also the fallback for cases JEV is unsure about. */
async function modelJudge(
  { findings, items, question, scope }: JudgeInput,
  abortSignal?: AbortSignal
): ReturnType<GateDeps["judge"]> {
  const model = await resolveModel("gate");
  const { object } = await generateObject({
    abortSignal,
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
}

/** A sentence saying the widget cannot change the account. */
const CANT_CHANGE =
  /[^.!?\n]*\b(?:not able to|unable to|can(?:'|no)t) make (?:any )?changes to (?:your|the) account\b[^.!?\n]*[.!?]\s*/giu;

/**
 * Live 2026-09-23: "can you look into it for me" got "I'm not able to make
 * changes to your account" first. Unasked, that sentence never goes out.
 */
const unaskedChangeRemoved = (composed: string, askedForChange: boolean) =>
  askedForChange ? composed : composed.replace(CANT_CHANGE, "").trim();

export const defaultGateDeps: GateDeps = {
  async compose({ askedForChange, findings, organizationName, question }) {
    const model = await resolveModel("widget");
    const { text } = await generateText({
      model: gateway(model),
      ...fastCallOptions(model),
      prompt: JSON.stringify({
        askedForChange: askedForChange === true,
        findings,
        question,
        workspace: organizationName,
      }),
      system: COMPOSER_PROMPT,
    });
    return text.trim();
  },
  judge: (input) =>
    process.env.WIDGET_REVIEWER === "jev"
      ? reviewWidgetFindings(input, { fallback: modelJudge })
      : modelJudge(input),
  resolve: resolveOwnedIdentifiers,
};

const handoffOnly = (findings: WidgetFindings) =>
  findings.needsHuman && findings.facts.length === 0;

/** Apply the judge's deletions; a string is the reason they cannot be used. */
function applyRewrite(
  findings: WidgetFindings,
  remove: number[]
): WidgetFindings | string {
  const rewritten = removeItems(findings, remove);
  if (rewritten) {
    return rewritten;
  }
  const items = redactableItems(findings);
  const drop = new Set(remove);
  return removesLastCaveat(
    items,
    items.filter((item) => !drop.has(item.n))
  )
    ? "model_gate:removed_last_caveat"
    : "model_gate:invalid_rewrite";
}

const blocked = (findings: WidgetFindings, reason: string): GateResult => ({
  decision: "block",
  findings,
  message: null,
  reason,
});

// A good answer was blocked whole because one sentence of the recommendation
// cited a known issue as "(ENG-14065)". A ticket number is never the customer's to
// see, so the item that carries one is dropped by the same delete-only rewrite the
// judge uses: nothing is reworded, and what survives is text the investigator
// wrote. Returns null when nothing would be left, and the caller then blocks.
export function withoutTicketRefs(
  findings: WidgetFindings
): WidgetFindings | null {
  const cites = redactableItems(findings)
    .filter((item) =>
      (item.text.match(LINEAR_REF) ?? []).some(
        (ref) => ref !== findings.ticket?.id
      )
    )
    .map((item) => item.n);
  return cites.length ? removeItems(findings, cites) : findings;
}

/** Deterministic identifier check, then the model gate, then the composer. Every failure blocks. */
export async function gate(
  scope: WidgetContext,
  question: string,
  investigated: WidgetFindings,
  deps: GateDeps = defaultGateDeps,
  /** The question within its conversation, for the composer only. */
  conversation: string = question,
  /** Jev's read of whether the customer asked for a change; see `asksForChange`. */
  askedForChange = false
): Promise<GateResult> {
  let findings = withoutTicketRefs(investigated) ?? investigated;
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
    let reason = await timed("scan", () =>
      deterministicReason(scope, findings, deps.resolve)
    );
    // A how-to answer was blocked whole, and the thread handed to a person,
    // because one item named "accounts.google.com". An identifier the workspace
    // does not own never reaches the customer, but the item carrying it is
    // deleted rather than the whole reply: nothing is reworded, and the scan runs
    // again on what is left. It still blocks when nothing would be left or the
    // identifier sits outside the removable items.
    for (
      let pass = 0;
      reason?.startsWith(FOREIGN_PREFIX) && pass < MAX_FOREIGN_PASSES;
      pass += 1
    ) {
      const foreign = reason.slice(FOREIGN_PREFIX.length);
      const trimmed = removeItems(
        findings,
        redactableItems(findings)
          .filter((item) => {
            const { candidates } = scanIdentifiers(item.text);
            return Object.values(candidates).some((ids) =>
              ids.includes(foreign)
            );
          })
          .map((item) => item.n)
      );
      if (!trimmed) {
        break;
      }
      findings = trimmed;
      const current = findings;
      // biome-ignore lint/performance/noAwaitInLoops: each pass scans what the last one left.
      reason = await timed("scan", () =>
        deterministicReason(scope, current, deps.resolve)
      );
    }
    if (reason) {
      return done(blocked(findings, reason));
    }
    // A handoff with nothing concrete to say needs no review: there is nothing
    // to show anyone.
    if (handoffOnly(findings)) {
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
    // Acquisity discards the reply whenever needsHuman is set: it posts the
    // findings as a team-only note and shows its own handoff message. Composing
    // one cost 58 seconds for nothing, so the reviewed handoff stops here.
    if (findings.needsHuman) {
      return done(blocked(findings, "needs_human"));
    }
    let gated = findings;
    if (verdict.decision === "rewrite") {
      const rewritten = applyRewrite(findings, verdict.remove ?? []);
      if (typeof rewritten === "string") {
        return done(blocked(findings, rewritten));
      }
      gated = rewritten;
      const again = await timed("scan", () =>
        deterministicReason(scope, gated, deps.resolve)
      );
      if (again) {
        return done(blocked(findings, again));
      }
    }
    const composed = await timed("compose", () =>
      deps.compose({
        askedForChange,
        findings: composerInput(gated),
        organizationName: scope.organizationName,
        question: conversation,
      })
    );
    const message = unaskedChangeRemoved(composed, askedForChange);
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
