import { normalize } from "./widget-replay.js";

/**
 * Live re-runs (ENG-15026, `pnpm widget:live`): pure pieces of the report. The
 * runner is scripts/widget-live.ts.
 */

/**
 * Widget tools that accept an absolute date today: the re-run asks for the
 * original conversation date on these. widget_job_failures and
 * widget_generation_diagnostics (`since`), widget_lead_pipeline_status
 * (`sinceDays`) and widget_sdr_thread_status (a fixed 30 days) only take
 * windows that end now, so they cannot be pinned; every other tool has no
 * date input.
 */
export const DATED_TOOLS: Readonly<Record<string, string>> = {
  widget_billing_summary: "creditWindow",
  widget_outreach_health: "startDate and endDate",
};

/** The original message with a teammate's note pinning dated reads to the day it was sent. */
export const pinnedQuestion = (question: string, sentAt: string) =>
  `${question}\n\n(Team re-run: the customer sent this on ${sentAt.slice(0, 10)}. Where a read accepts a date window (${Object.keys(DATED_TOOLS).join(", ")}), ask about that date.)`;

const SENTENCE_BREAK = /(?<=[.!?])\s+|\n+/;
const UNCONFIRMED =
  /\b(?:could(?: not|n['’]t)|can(?:not| not|['’]t)|unable to|not able to|not available|unavailable|no access|nothing on record|no record|didn['’]t come back|(?:does|did)(?: not|n['’]t) (?:document|show)|no [\w ]{0,40}(?:recorded|on record|found))\b/i;

/**
 * The sentences of a reply that say something could not be confirmed. ENG-15024
 * seam: replace with its tool-gap classifier once it merges.
 */
export const gapSentences = (reply: string | null) =>
  (reply ?? "")
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter((sentence) => UNCONFIRMED.test(sentence));

/** Reads with no stored state to compare: customer clarification and the stubbed ticket. */
export const NOT_READS = new Set(["widget_ask_customer", "widget_file_ticket"]);

// Drift rule: a read is steady when its re-read output equals the recording
// structurally (keys sorted, null fields dropped, as replay matches inputs)
// after removing `observedAt`, the only field that stamps when a read ran. A
// recording that reported itself unavailable holds no state to compare: it is
// listed apart (a tool gap) and does not decide the verdict.
const comparable = (output: unknown) =>
  JSON.stringify(
    normalize(
      JSON.parse(JSON.stringify(output ?? null), (key, value) =>
        key === "observedAt" ? undefined : value
      )
    )
  );
const wasUnavailable = (output: unknown) =>
  typeof output === "object" &&
  output !== null &&
  ("available" in output
    ? output.available === false
    : "status" in output && output.status === "unavailable");

export function driftVerdict(
  reads: readonly { output: unknown; reread: unknown; tool: string }[]
) {
  const unavailable = reads.filter((read) => wasUnavailable(read.output));
  const changed = reads
    .filter(
      (read) =>
        !unavailable.includes(read) &&
        comparable(read.output) !== comparable(read.reread)
    )
    .map((read) => read.tool);
  return {
    changed,
    compared: reads.length - unavailable.length,
    unavailable: unavailable.map((read) => read.tool),
    verdict: changed.length ? ("state moved" as const) : ("steady" as const),
  };
}
