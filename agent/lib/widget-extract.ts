import { gateway, generateObject } from "ai";
import { z } from "zod";
import { fastCallOptions, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
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
});
type LenientFindings = z.infer<typeof extractionSchema>;
type LenientFinding = NonNullable<LenientFindings["facts"]>[number];

const EXTRACT_PROMPT = `You convert an internal support investigator's free-form findings into a structured object. You receive the customer's question and the investigator's written findings. For each concrete finding, produce a fact with: claim (the finding), evidenceTool (the tool or record it came from, if named), evidenceRef (any reference/id string it cited), and entityIds (identifiers it named). Also produce: recommendation (what to do), confidence (low, medium or high), needsHuman (true only when the investigator concluded it cannot give a useful answer and a person must take over, e.g. wrong workspace or no usable findings; also true when the investigator sent a suspected duplicate, cross-workspace or unmatched charge, or an order with unconfirmed payment or incomplete delivery, to billing review by a person, and then keep every fact and put the unresolved questions in recommendation; do NOT set it merely because one detail could not be verified while the main question was still answered, but an unresolved payment or delivery sent to billing review is never such a detail), needsWrite (a change that was needed but could not be made), ticketId/ticketUrl only if the investigator says it created an ENG-#### ticket during this investigation (never for an existing or related ticket it merely mentions), and report (the investigator's plain-English summary for a teammate, kept to one or two short sentences and 40 words at most; shorten it if the investigator ran long, and never make it more certain than the facts: what the facts leave unconfirmed stays unconfirmed, never paid, unpaid, working or lost). Always include, as its own fact, anything the investigator said it could not check or verify, because the customer must be told what remains uncertain; word it as what remains unknown about the customer's workspace, using only what the investigator said, never as the internal source (a run trace, a log, a telemetry feed, step detail) that could not be read. Copy faithfully; never invent a fact, id, reference, link or ticket the investigator did not state. If the investigator only asked the customer a clarifying question, or simply replied to a message that needed nothing looked up, that is a normal reply and not a failure: return an empty facts array, needsHuman false, and put what it said to the customer into recommendation and report. If instead the investigator could not produce any useful answer, return an empty facts array, needsHuman true, and put whatever was said into recommendation and report.`;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

const strArr = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .map((x) => x.slice(0, maxLen))
        .slice(0, maxItems)
    : [];

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
  };
  return parseFindings(candidate);
}

export interface ExtractInput {
  investigatorText: string;
  question: string;
  scope: WidgetContext;
}
export interface ExtractDeps {
  generate: (input: ExtractInput) => Promise<unknown>;
}

export const defaultExtractDeps: ExtractDeps = {
  async generate({ investigatorText, question, scope }) {
    // Reformatting the investigator's prose needs no reasoning, and the gate
    // re-validates everything downstream, so this runs on the fast slot.
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      model: gateway(model),
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
