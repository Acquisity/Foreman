/**
 * Pure logic behind `pnpm widget:candidates` (ENG-14750): which production
 * widget conversations are worth an eval case, and what the operator reviews.
 * The script owns every read and write; nothing here touches the network or disk.
 */
import { z } from "zod";
import { parseFindings } from "./widget-findings.js";
import { widgetOutcomeSchema } from "./widget-run-store.js";

/** Where review files and pull state live. `.eve/` is gitignored, so raw customer text never enters the repo. */
export const CANDIDATES_OUTPUT = ".eve/widget-candidates";

export const candidateRowSchema = z.object({
  completed_at: z.coerce.date(),
  conversation_id: z.uuid(),
  created_at: z.coerce.date(),
  decision: z.string().nullable(),
  findings: z.unknown().nullable(),
  id: z.uuid(),
  organization_id: z.uuid(),
  // An outcome written by an older build is kept as a turn with no answer.
  outcome: widgetOutcomeSchema.nullable().catch(null),
  question: z.string(),
  scope: z.object({ organizationSlug: z.string().optional() }).catch({}),
  session_id: z.string().nullable(),
});
export type CandidateRow = z.infer<typeof candidateRowSchema>;

export const pullStateSchema = z.object({
  /** Runs that completed in the same millisecond as `through`, already pulled. */
  seen: z.array(z.uuid()),
  /** Completion time of the newest run already pulled. */
  through: z.iso.datetime(),
});
export type PullState = z.infer<typeof pullStateSchema>;

export type SignalKind =
  | "asked_for_human"
  | "clarify_only"
  | "handoff"
  | "kb_miss"
  | "pushback"
  | "repeated_kb_miss"
  | "rewrite";

export interface Signal {
  kind: SignalKind;
  /** The run the signal is about; a pushback names the answered run and the reply to it. */
  runIds: string[];
}

export interface Candidate {
  conversationId: string;
  /** Investigation runs (`wrun_` sessions) behind a signal, ready for the case converter. */
  investigationSessions: string[];
  organizationId: string;
  signals: Signal[];
  turns: CandidateRow[];
  workspace: string | null;
}

/** Explicit test-workspace organization ids, comma separated. Anything else is refused, so a typo cannot silently exclude nothing. */
export const parseExcludedOrgs = (value: string | undefined) =>
  new Set(
    z.array(z.uuid()).parse(
      (value ?? "")
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean)
    )
  );

const PUSHBACK =
  /\b(not help(ing|ful)?|(that'?s|this is|you'?re|it'?s) (wrong|not (right|correct|true|it))|incorrect|useless|does ?n[o']t (help|work|answer)|did ?n[o']t (help|work|answer)|still (not|does ?n[o']t|have|broken)|same (problem|issue|question)|you (already|just) said|i already (said|told|asked))\b/i;
const MAX_TEXT = 4000;
const NON_WORD = /[^a-z0-9]+/;
const words = (text: string) =>
  new Set(
    text
      .slice(0, MAX_TEXT)
      .toLowerCase()
      .split(NON_WORD)
      .filter((word) => word.length > 2)
  );

/** The customer asked the same thing again: most of the words of the shorter question recur. */
export function repeatsQuestion(previous: string, next: string): boolean {
  const a = words(previous);
  const b = words(next);
  const smaller = Math.min(a.size, b.size);
  if (smaller < 3) {
    return previous.trim().toLowerCase() === next.trim().toLowerCase();
  }
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / smaller >= 0.8;
}

export const isPushback = (previous: string, next: string) =>
  PUSHBACK.test(next.slice(0, MAX_TEXT)) || repeatsQuestion(previous, next);

const isInvestigation = (row: CandidateRow) =>
  Boolean(row.session_id?.startsWith("wrun_"));
const decisionOf = (row: CandidateRow) => row.outcome?.decision ?? row.decision;

/** Every signal in one conversation's turns, oldest first. */
export function conversationSignals(turns: CandidateRow[]): Signal[] {
  const signals: Signal[] = [];
  const misses = turns.filter((row) => row.outcome?.reason === "kb_miss");
  for (const [index, row] of turns.entries()) {
    const reason = row.outcome?.reason;
    const findings = parseFindings(row.findings);
    if (reason === "kb_miss") {
      signals.push({
        kind: misses.length > 1 ? "repeated_kb_miss" : "kb_miss",
        runIds: [row.id],
      });
    }
    if (reason === "asked_for_human") {
      signals.push({ kind: "asked_for_human", runIds: [row.id] });
    } else if (decisionOf(row) === "block" || findings?.needsHuman) {
      signals.push({ kind: "handoff", runIds: [row.id] });
    }
    if (decisionOf(row) === "rewrite") {
      signals.push({ kind: "rewrite", runIds: [row.id] });
    }
    if (
      isInvestigation(row) &&
      findings &&
      !findings.facts.length &&
      !findings.needsHuman
    ) {
      signals.push({ kind: "clarify_only", runIds: [row.id] });
    }
    const previous = turns[index - 1];
    if (previous && isPushback(previous.question, row.question)) {
      signals.push({ kind: "pushback", runIds: [previous.id, row.id] });
    }
  }
  return signals;
}

/**
 * Group completed runs into conversations and keep the ones with a signal on a
 * run not pulled before. Older runs of the same conversation stay as context,
 * so a pushback against an earlier answer is still seen.
 */
export function flagConversations(
  rows: CandidateRow[],
  options: { excluded: Set<string>; isNew: (row: CandidateRow) => boolean }
): Candidate[] {
  const conversations = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (options.excluded.has(row.organization_id.toLowerCase())) {
      continue;
    }
    const key = `${row.organization_id}/${row.conversation_id}`;
    conversations.set(key, [...(conversations.get(key) ?? []), row]);
  }
  return [...conversations.values()].flatMap((unsorted) => {
    const turns = [...unsorted].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );
    const fresh = new Set(turns.filter(options.isNew).map((row) => row.id));
    const signals = conversationSignals(turns).filter((signal) =>
      signal.runIds.some((id) => fresh.has(id))
    );
    if (!signals.length) {
      return [];
    }
    const flagged = new Set(signals.flatMap((signal) => signal.runIds));
    const [first] = turns;
    return [
      {
        conversationId: first.conversation_id,
        investigationSessions: [
          ...new Set(
            turns
              .filter((row) => flagged.has(row.id) && isInvestigation(row))
              .map((row) => row.session_id ?? "")
          ),
        ],
        organizationId: first.organization_id,
        signals,
        turns,
        workspace: turns.at(-1)?.scope.organizationSlug ?? null,
      },
    ];
  });
}

/** Where the next pull starts: the newest completion pulled, and the runs that share its millisecond. */
export function nextPullState(
  rows: CandidateRow[],
  previous: PullState | null
): PullState | null {
  const newest = Math.max(...rows.map((row) => row.completed_at.getTime()));
  if (!(rows.length && Number.isFinite(newest))) {
    return previous;
  }
  const through = new Date(newest).toISOString();
  const seen = rows
    .filter((row) => row.completed_at.getTime() === newest)
    .map((row) => row.id);
  return {
    seen: [
      ...new Set([
        ...seen,
        ...(previous?.through === through ? previous.seen : []),
      ]),
    ],
    through,
  };
}

/** A case file name the converter accepts, derived from the run id alone. */
export const pendingCaseName = (sessionId: string) =>
  `candidate-${sessionId.toLowerCase().replace("_", "-")}`;

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** One review entry per flagged conversation: the exchange, the signals and the run ids. */
export function renderReview(candidates: Candidate[], pulledAt: string) {
  const entries = candidates.map((candidate) => {
    const turns = candidate.turns.map((row) =>
      [
        `Customer (run ${row.id}${row.session_id && row.session_id !== row.id ? `, session ${row.session_id}` : ""}):`,
        quote(row.question),
        `Widget (${row.outcome?.reason ?? "no outcome"}, ${decisionOf(row) ?? "no decision"}):`,
        quote(row.outcome?.message ?? "(no reply)"),
      ].join("\n\n")
    );
    const signals = candidate.signals
      .map((signal) => `- ${signal.kind}: ${signal.runIds.join(", ")}`)
      .join("\n");
    return [
      `## ${candidate.workspace ?? candidate.organizationId} / ${candidate.conversationId}`,
      `Signals:\n\n${signals}`,
      ...turns,
    ].join("\n\n");
  });
  return `# Widget case candidates pulled ${pulledAt}\n\n${entries.join("\n\n---\n\n")}\n`;
}
