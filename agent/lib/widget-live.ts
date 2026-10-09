import { normalize } from "./widget-normalize.js";

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

export type ReadResult =
  | { status: "ok"; output: unknown }
  | { status: "unverifiable" };

/** A partial or failed source cannot establish that customer state stayed the same. */
const unavailable = (value: unknown, root = true): boolean => {
  if (Array.isArray(value)) {
    return value.some(
      (child) => child && typeof child === "object" && unavailable(child, false)
    );
  }
  if (!value || typeof value !== "object") {
    return value === null || value === undefined;
  }
  const item = value as Record<string, unknown>;
  if (
    item.available === false ||
    item.success === false ||
    item.ok === false ||
    item.isError === true ||
    item.status === "unavailable" ||
    item.status === "denied" ||
    (root &&
      (["error", "failed", "cancelled"].includes(String(item.status)) ||
        Boolean(item.error))) ||
    (Array.isArray(item.unavailable) && item.unavailable.length)
  ) {
    return true;
  }
  // Only nested objects can carry source status; nullable data fields are legitimate.
  return Object.values(item).some(
    (child) => child && typeof child === "object" && unavailable(child, false)
  );
};

export function readResult(output: unknown, status?: string): ReadResult {
  return ["error", "failed", "denied", "cancelled"].includes(status ?? "") ||
    unavailable(output)
    ? { status: "unverifiable" }
    : { output, status: "ok" };
}

// Structural equality of bounded output, with key order/null normalization shared
// with replay and only observedAt (read time) removed. Failed/partial reads carry
// no comparable state. Movement requires a real change; steady requires complete,
// nonempty comparison evidence. Cause grading is permitted only for steady cases.
const comparable = (output: unknown) =>
  JSON.stringify(
    normalize(
      JSON.parse(JSON.stringify(output), (key, value) =>
        key === "observedAt" ? undefined : value
      )
    )
  );

export function driftVerdict(
  reads: readonly { recorded: ReadResult; reread: ReadResult; tool: string }[]
) {
  const changed: string[] = [];
  const unverifiable: string[] = [];
  let compared = 0;
  for (const read of reads) {
    if (read.recorded.status !== "ok" || read.reread.status !== "ok") {
      unverifiable.push(read.tool);
      continue;
    }
    compared += 1;
    if (comparable(read.recorded.output) !== comparable(read.reread.output)) {
      changed.push(read.tool);
    }
  }
  let verdict: "state moved" | "steady" | "unverifiable" = "unverifiable";
  if (changed.length) {
    verdict = "state moved";
  } else if (compared && !unverifiable.length) {
    verdict = "steady";
  }
  return {
    causeGradeAllowed: verdict === "steady",
    changed,
    compared,
    unverifiable,
    verdict,
  };
}
