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

/**
 * A failed read cannot establish that customer state stayed the same. Only the
 * read as a whole counts: tools also mark sub-objects `available: false` on
 * purpose (an outreach listing's per-campaign `live`, billing's skipped
 * Autumn), and those are dropped from the comparison instead. A dropped part
 * can also be a nested source that failed, so a read with one can show
 * movement but never proves the state stayed the same.
 */
const failed = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value === null || value === undefined;
  }
  const item = value as Record<string, unknown>;
  return (
    item.available === false ||
    item.success === false ||
    item.ok === false ||
    item.isError === true ||
    ["unavailable", "denied", "error", "failed", "cancelled"].includes(
      String(item.status)
    ) ||
    Boolean(item.error)
  );
};

export function readResult(output: unknown, status?: string): ReadResult {
  return ["error", "failed", "denied", "cancelled"].includes(status ?? "") ||
    failed(output)
    ? { status: "unverifiable" }
    : { output, status: "ok" };
}

// Structural equality of bounded output, with key order/null normalization shared
// with replay and only observedAt (read time) removed. Failed/partial reads carry
// no comparable state. Movement requires a real change; steady requires complete,
// nonempty comparison evidence. Cause grading is permitted only for steady cases.
const isDropped = (value: unknown) =>
  Boolean(value) &&
  typeof value === "object" &&
  (value as { available?: unknown }).available === false;

/**
 * A part marked unavailable on either side leaves both sides, so a source
 * that was readable when recorded and unavailable on the re-read (or the
 * reverse) is never counted as movement.
 */
const pruneBoth = (a: unknown, b: unknown): [unknown, unknown] => {
  if (isDropped(a) || isDropped(b)) {
    return [undefined, undefined];
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const pairs = a.map((item, index) => pruneBoth(item, b[index]));
    return [
      pairs.map(([left]) => left),
      [...pairs.map(([, right]) => right), ...b.slice(a.length)],
    ];
  }
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left: Record<string, unknown> = {};
    const right: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === "observedAt") {
        continue;
      }
      [left[key], right[key]] = pruneBoth(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      );
    }
    return [left, right];
  }
  return [a, b];
};

const comparable = (output: unknown) =>
  JSON.stringify(normalize(JSON.parse(JSON.stringify(output ?? null))));

const sameState = (recorded: unknown, reread: unknown) => {
  const [left, right] = pruneBoth(recorded, reread);
  return comparable(left) === comparable(right);
};

const hasDropped = (value: unknown): boolean =>
  isDropped(value) ||
  (Boolean(value) &&
    typeof value === "object" &&
    Object.values(value as object).some(hasDropped));

export function driftVerdict(
  reads: readonly { recorded: ReadResult; reread: ReadResult; tool: string }[]
) {
  const changed: string[] = [];
  const partial: string[] = [];
  const unverifiable: string[] = [];
  let compared = 0;
  for (const read of reads) {
    if (read.recorded.status !== "ok" || read.reread.status !== "ok") {
      unverifiable.push(read.tool);
      continue;
    }
    compared += 1;
    if (!sameState(read.recorded.output, read.reread.output)) {
      changed.push(read.tool);
    }
    if (hasDropped(read.recorded.output) || hasDropped(read.reread.output)) {
      partial.push(read.tool);
    }
  }
  let verdict: "state moved" | "steady" | "unverifiable" = "unverifiable";
  if (changed.length) {
    verdict = "state moved";
  } else if (compared && !unverifiable.length && !partial.length) {
    verdict = "steady";
  }
  return {
    causeGradeAllowed: verdict === "steady",
    changed,
    compared,
    partial,
    unverifiable,
    verdict,
  };
}
