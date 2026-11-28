import { generateObject } from "ai";
import { z } from "zod";
import { fastCallOptions, modelFor, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import { GAP_AREAS } from "./widget-capability-gaps.js";
import { parseFindings, type WidgetFindings } from "./widget-findings.js";
import type { WidgetContext } from "./widget-scope.js";

const TICKET_ID = /^ENG-\d+$/;

/**
 * A deliberately lenient shape for the extraction model. The strict
 * findingsSchema (nested strictObjects, every field required) is hard for a
 * small model to satisfy through generateObject; asking for this loose shape
 * and normalizing it ourselves is far more reliable. The gate re-validates
 * everything downstream, so leniency here costs no safety.
 */
const extractionSchema = z.object({
  confidence: z.enum(["low", "medium", "high"]).optional(),
  facts: z
    .array(
      z.object({
        claim: z.string(),
        entityIds: z.array(z.string()).optional(),
        evidenceRef: z.string().optional(),
        evidenceTool: z.string().optional(),
      })
    )
    .optional(),
  needsHuman: z.boolean().optional(),
  needsWrite: z.string().optional(),
  recommendation: z.string().optional(),
  report: z.string().optional(),
  ticketId: z.string().optional(),
  ticketUrl: z.string().optional(),
  unchecked: z
    .array(
      z.object({
        area: z.string(),
        fact: z.string(),
        kind: z.string().optional(),
        reason: z.string().optional(),
      })
    )
    .optional(),
});
type LenientFindings = z.infer<typeof extractionSchema>;
type LenientFinding = NonNullable<LenientFindings["facts"]>[number];

// In the order the model checks them. Items with a dropped reason are not a gap on our side: told only
// to leave them out, the model still listed them in 3 or 4 of 10 runs of a replayed case (ENG-21513).
const UNCHECKED_REASONS = [
  { id: "read_failed", means: "a read failed, timed out or was unavailable" },
  {
    drop: true,
    id: "asked_customer",
    means:
      "only the customer has it and the investigator asked them to tell, paste, send or show it; when our own records or the Help Centre should hold it too, use no_read or docs_missing instead",
  },
  {
    drop: true,
    id: "customer_only",
    means:
      "only the customer can know it, such as what their screen shows or what an email they received says",
  },
  {
    drop: true,
    id: "future",
    means:
      "it will only be known once it happens; a record that should exist today is no_read",
  },
  {
    drop: true,
    id: "waiting_on_customer",
    means:
      "it could not run yet because of something the customer still has to do",
  },
  { drop: true, id: "person_decides", means: "a decision still with a person" },
  {
    id: "docs_missing",
    means: "the investigator said the Help Centre does not explain it",
  },
  {
    id: "no_read",
    means: "our data should hold it but there was no way to read it",
  },
] as const;
const DROPPED_REASONS = new Set<string>(
  UNCHECKED_REASONS.filter((r) => "drop" in r).map((r) => r.id)
);

export const EXTRACT_PROMPT = `You convert an internal support investigator's free-form findings into a structured object. You receive the customer's question and the investigator's written findings. Keep each fact to one independently useful finding. When the investigator lists records one by one, keep each record as its own fact with its date and amount, never folded into a total or a date range, and keep every amount with the date the investigator gave that record. Write every claim in plain words a customer would use, never as a tool's field names, booleans or codes: write "not connected" for connected:false, "none of the 3 sending accounts are healthy" for healthyCount 0 of 3, and "no reason for not sending was recorded" for notSendingReason null. Do not bundle a customer-facing diagnosis with ancillary provider hostnames or identifiers: for example, keep observed versus recommended DNS addresses and their mismatch in a separate fact from nameserver hostnames, so filtering a provider reference cannot remove the diagnosis. For each concrete finding, produce a fact with: claim (the finding), evidenceTool (the tool or record it came from, if named), evidenceRef (any reference/id string it cited), and entityIds (identifiers it named). Also produce: recommendation (what to do), confidence (low, medium or high), needsHuman (true only when the customer explicitly asked to talk to a person, or the investigator concluded it cannot give any useful answer at all, e.g. no usable findings; a billing dispute, a refund request, an order with unconfirmed payment or incomplete delivery, and a documented step the customer already tried that failed are filed as a ticket, not handed to a person, so needsHuman stays false for them, every fact is kept and the unresolved questions go in recommendation; do NOT set it merely because one detail could not be verified while the main question was still answered; when the customer already tried the documented step and it failed, for example their recent reconnect attempts all failed, the recommendation states what failed and never tells them to repeat that step or wait it out), needsWrite (a change that was needed but could not be made), ticketId/ticketUrl only if the investigator says it created an ENG-#### ticket during this investigation (never for an existing or related ticket it merely mentions), and report (the investigator's plain-English summary for a teammate, kept to one or two short sentences and 40 words at most; shorten it if the investigator ran long, and never make it more certain than the facts: what the facts leave unconfirmed stays unconfirmed, never paid, unpaid, working or lost). Always include, as its own fact, anything the investigator said it could not check or verify, because the customer must be told what remains uncertain; word it as what remains unknown about the customer's workspace, using only what the investigator said, never as the internal source (a run trace, a log, a telemetry feed, step detail) that could not be read. A tool status of ok or normal means the read worked, never that the thing is healthy, and nothing recorded is never "no action is needed": when the investigator wrote that no action is needed or nothing needs changing while also saying something could not be checked, leave that phrase out of recommendation and report and keep what was and was not recorded. Copy faithfully; never invent a fact, id, reference, link or ticket the investigator did not state. Also list in unchecked each thing the investigator said it could not check, verify or see because of something on our side (a read that failed, timed out or was unavailable, something our data should hold that it had no way to read, or a product question the Help Centre does not explain), except a refusal by design (another workspace, card details, internal tickets, a feature that is off for the workspace): area is the product area it belongs to (${GAP_AREAS.join(", ")}; other when none fits: inboxes covers sending inboxes and their domains, DNS, warmup and sending health; website covers sites, funnels and their custom domains; orders covers inbox and domain orders; billing covers charges, credits and refunds), fact is the missing fact in general terms, the same for any customer, in lower case, with no names, emails, domains, ids, numbers, dates or quotes from this workspace, under 160 characters (for example "why a managed domain is suspended"), kind is docs when the Help Centre does not explain a product question, otherwise tool, and reason is the first of these that fits it: ${UNCHECKED_REASONS.map(({ id, means }) => `${id} (${means})`).join(", ")}. Before listing an item, ask whether a read of our data or the Help Centre could have answered it at the time; if only the customer could answer it or act on it first, leave it out. Never list in unchecked a question the investigator asked the customer or something it asked them to tell us (which site, contact, domain or campaign they mean, which of the matches in a cut-off list, what a page, screen or section of the app shows them, since we read their data and never their screen, or what an email or message they received says), something only the customer can know (what they clicked, saw or meant, whether two things they saw are linked, how their outside providers are set up), whether something will happen later or what a number will be at a future date (such as a renewal going through, or performance numbers at year end), which no data can know until it happens, a check that could not run yet only because of something the customer still has to do (such as HTTPS on a domain with no public records yet, or a site that was never published), a decision still with a person (such as whether a refund will be approved), or anything the investigator did not itself say it could not check; a read that failed or timed out, a source reported as unavailable, and a product question the Help Centre does not explain (kind docs) are still listed, even when the investigator also asked the customer to send what it could not read. If the investigator only asked the customer a clarifying question, or simply replied to a message that needed nothing looked up, that is a normal reply and not a failure: return an empty facts array, needsHuman false, and put what it said to the customer into recommendation and report. If instead the investigator could not produce any useful answer, return an empty facts array, needsHuman true, and put whatever was said into recommendation and report.`;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

const strArr = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .map((x) => x.slice(0, maxLen))
        .slice(0, maxItems)
    : [];

const WHITESPACE = /\s+/gu;
const uncheckedArea = z.enum(GAP_AREAS).catch("other");
const uncheckedKind = z.enum(["docs", "tool"]).catch("tool");

/** Each unchecked fact the extractor did not put on the customer, the future or a person, and every Help Centre gap; replyGaps decides what may be filed. */
function uncheckedFacts(
  raw: LenientFindings["unchecked"]
): Pick<WidgetFindings, "unchecked"> {
  const unchecked = (raw ?? [])
    .map((item) => ({
      area: uncheckedArea.parse(item.area),
      fact: item.fact.replace(WHITESPACE, " ").trim().slice(0, 160),
      kind: uncheckedKind.parse(item.kind),
      reason: item.reason?.trim().toLowerCase() ?? "",
    }))
    .filter(
      ({ kind, reason }) => kind === "docs" || !DROPPED_REASONS.has(reason)
    )
    .map(({ reason: _reason, ...item }) => item)
    .filter((item) => item.fact.length >= 3)
    .slice(0, 10);
  return unchecked.length ? { unchecked } : {};
}

/** Build the strict WidgetFindings from the lenient model output, filling required fields. */
function normalize(
  raw: LenientFindings,
  question: string
): WidgetFindings | null {
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((f: LenientFinding) => ({
      claim: str(f.claim, 2000),
      entityIds: strArr(f.entityIds, 50, 200),
      evidence: {
        ref: str(f.evidenceRef, 500),
        tool: str(f.evidenceTool, 200) || "investigation",
      },
    }))
    .filter((f) => f.claim.length > 0)
    .slice(0, 50);

  const modelRec = str(raw.recommendation, 4000);
  const modelReport = str(raw.report, 1000);
  // Nothing usable — let the caller hand the raw investigator prose to a human
  // instead of a hollow default-filled note.
  if (facts.length === 0 && !modelRec && !modelReport) {
    return null;
  }
  const recommendation =
    modelRec ||
    modelReport ||
    "The investigator did not record a recommendation.";
  const report =
    modelReport ||
    str(raw.recommendation, 1000) ||
    `No summary was produced for: ${question}`.slice(0, 1000);
  const confidence =
    raw.confidence === "medium" || raw.confidence === "high"
      ? raw.confidence
      : "low";
  // A handoff is an explicit conclusion, never a fallback. Having no facts is
  // normal when the investigator asked a clarifying question or just replied, so
  // it no longer forces a human; the gate still hands off when the investigator
  // did ask for one and there is nothing to tell the customer.
  const needsHuman = raw.needsHuman === true;

  const candidate: WidgetFindings = {
    confidence,
    facts,
    needsHuman,
    recommendation,
    report,
    ...(str(raw.needsWrite, 2000)
      ? { needsWrite: str(raw.needsWrite, 2000) }
      : {}),
    ...(typeof raw.ticketId === "string" &&
    TICKET_ID.test(raw.ticketId) &&
    typeof raw.ticketUrl === "string"
      ? { ticket: { id: raw.ticketId, url: raw.ticketUrl.slice(0, 500) } }
      : {}),
    ...uncheckedFacts(raw.unchecked),
  };
  return parseFindings(candidate);
}

export interface ExtractInput {
  investigatorText: string;
  question: string;
  scope: WidgetContext;
  /** The run's remaining finish deadline, when the caller has one. */
  signal?: AbortSignal;
}
export interface ExtractDeps {
  generate: (input: ExtractInput) => Promise<unknown>;
}

/** Part of the finish budget in widget-egress: a stall hands the write-up to a person instead of holding the reply. */
const EXTRACT_TIMEOUT_MS = 25_000;

export const defaultExtractDeps: ExtractDeps = {
  async generate({ investigatorText, question, scope, signal }) {
    // Reformatting the investigator's prose needs no reasoning, and the gate
    // re-validates everything downstream, so this runs on the fast slot.
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      abortSignal: signal
        ? AbortSignal.any([AbortSignal.timeout(EXTRACT_TIMEOUT_MS), signal])
        : AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      model: modelFor(model),
      ...fastCallOptions(model),
      prompt: JSON.stringify({
        findings: investigatorText,
        question,
        workspace: scope.organizationName,
      }),
      schema: extractionSchema,
      system: EXTRACT_PROMPT,
    });
    return object;
  },
};

// The line widget_file_ticket tells the investigator to end its write-up with.
// Read by pattern, never by a model, and only a link whose path names the same
// ticket counts, so a known issue mentioned in passing is never linked.
const FILED_TICKET =
  /^Ticket filed: (ENG-\d+) (https:\/\/linear\.app\/acquisity\/issue\/(ENG-\d+)[^\s]*)\s*$/mu;
export function filedTicket(text: string): { id: string; url: string } | null {
  const match = FILED_TICKET.exec(text);
  return match && match[1] === match[3]
    ? { id: match[1], url: match[2].slice(0, 500) }
    : null;
}

/**
 * One small-model pass turns the investigator's prose into validated findings.
 * The investigator no longer emits the strict schema itself, so a normal
 * write-up can never fail the session; this step reformats it and returns null
 * when it cannot, leaving the caller to hand the prose to a human.
 */
export async function extractWidgetFindings(
  input: ExtractInput,
  deps: ExtractDeps = defaultExtractDeps
): Promise<WidgetFindings | null> {
  if (!input.investigatorText.trim()) {
    return null;
  }
  try {
    // The closing ticket line is for the pattern below alone: left in, the model
    // pass can copy its link into a fact, and the gate blocks any linear.app link.
    const raw = (await deps.generate({
      ...input,
      investigatorText: input.investigatorText.replace(FILED_TICKET, "").trim(),
    })) as LenientFindings;
    const extracted = normalize(raw, input.question);
    // The model pass is asked for the ticket too, but a filed ticket is never left
    // to it: ENG-14067 was filed, the write-up said only "ticket filed", and the
    // customer was told it could not be opened.
    const filed = filedTicket(input.investigatorText);
    const findings =
      extracted && filed ? { ...extracted, ticket: filed } : extracted;
    if (!findings) {
      logOpsEvent(
        "widget.extract.normalize_failed",
        { conversationId: input.scope.conversationId, outcome: "error" },
        console.warn
      );
    }
    return findings;
  } catch (error) {
    logOpsEvent(
      "widget.extract.generate_failed",
      {
        conversationId: input.scope.conversationId,
        message:
          error instanceof Error ? error.message.slice(0, 300) : "unknown",
        outcome: "error",
      },
      console.warn
    );
    return null;
  }
}
