import { z } from "zod";
import { type Candidate, parseExcludedOrgs } from "./widget-candidates.js";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import { parseFindings } from "./widget-findings.js";
import {
  type Claim,
  type JudgeRecord,
  SCORECARD_TARGETS,
  type scorecard,
  type Verdict,
} from "./widget-judge.js";
import { gapSentences } from "./widget-live.js";
import { widgetContextSchema } from "./widget-scope.js";

/**
 * Live scorecard (ENG-15044 round 7, `pnpm widget:live score`): pure pieces.
 * The runner is scripts/widget-live.ts. A set is picked once from production,
 * snapshotted under the gitignored `.eve/widget-live/sets/<name>/` (streams
 * expire after 7 days), then re-run live and judged with no hand-written
 * expectations.
 */
export const LIVE_SETS = ".eve/widget-live/sets";
export const DEFAULT_PICK = 20;

/** Completed customer investigations from the last 7 days, while their session streams still exist. */
export const LIVE_SET_QUERY = `
SELECT id, organization_id, conversation_id, question, scope, session_id, findings,
  decision, outcome, created_at, completed_at
FROM widget_support_runs
WHERE created_at >= now() - interval '7 days' AND completed_at IS NOT NULL
  AND session_id LIKE 'wrun\\_%' AND scope->>'source' IS DISTINCT FROM 'inbox'
  AND NOT (organization_id = ANY($1::uuid[]))
ORDER BY created_at DESC, id LIMIT 2000`;

export const TOPICS = [
  "billing",
  "website",
  "inboxes",
  "campaigns",
  "leads",
  "other",
] as const;
export type Topic = (typeof TOPICS)[number];

const TOPIC_WORDS: [Exclude<Topic, "other">, RegExp][] = [
  [
    "billing",
    /\b(bill\w*|charg\w*|refund\w*|invoice\w*|payment\w*|subscri\w*|credits?|pric\w*|plan|upgrade|downgrade)\b/i,
  ],
  ["website", /\b(website|landing page|site)\b/i],
  [
    "inboxes",
    /\b(inbox\w*|mailbox\w*|email accounts?|domains?|warm[- ]?up|deliverab\w*|spam|sending accounts?)\b/i,
  ],
  [
    "campaigns",
    /\b(campaigns?|sequences?|follow[- ]?ups?|steps?|sending|sent|paused?)\b/i,
  ],
  ["leads", /\b(leads?|contacts?|crm|prospects?|lists?)\b/i],
];

/** The first topic whose words the customer's message uses, in a fixed order. */
export const topicOf = (question: string): Topic =>
  TOPIC_WORDS.find(([, words]) => words.test(question.slice(0, 4000)))?.[0] ??
  "other";

/** The original reply admitted something it could not check, or only asked a clarifying question. */
export function admitsOrAsks(row: Candidate["turns"][number]) {
  const reply = row.outcome?.message ?? "";
  const findings = parseFindings(row.findings);
  return (
    gapSentences(reply).length > 0 ||
    reply.trim().endsWith("?") ||
    Boolean(findings && !findings.facts.length && !findings.needsHuman)
  );
}

/**
 * The runs to re-run, in order: the newest admitting or asking run of each
 * conversation (else its newest run), then round-robin across topics with
 * admitting or asking runs first. The runner snapshots down this list until
 * it has `count`, since a stream can expire or fail between pick and read.
 */
export function rankSet(
  rows: Candidate["turns"],
  excluded: Set<string> = parseExcludedOrgs(undefined)
) {
  const byConversation = new Map<string, Candidate["turns"]>();
  for (const row of rows) {
    if (
      excluded.has(row.organization_id.toLowerCase()) ||
      !row.session_id?.startsWith("wrun_") ||
      !row.outcome ||
      (row.scope as { source?: string }).source === "inbox"
    ) {
      continue;
    }
    const key = `${row.organization_id}/${row.conversation_id}`;
    byConversation.set(key, [...(byConversation.get(key) ?? []), row]);
  }
  const newestFirst = (a: { created_at: Date }, b: { created_at: Date }) =>
    b.created_at.getTime() - a.created_at.getTime();
  const picked = [...byConversation.values()].map((turns) => {
    const sorted = [...turns].sort(newestFirst);
    return sorted.find(admitsOrAsks) ?? (sorted[0] as (typeof sorted)[0]);
  });
  const queues = TOPICS.map((topic) =>
    picked
      .filter((row) => topicOf(row.question) === topic)
      .sort(
        (a, b) =>
          Number(admitsOrAsks(b)) - Number(admitsOrAsks(a)) || newestFirst(a, b)
      )
  );
  const ranked: { row: Candidate["turns"][number]; topic: Topic }[] = [];
  for (let round = 0; ranked.length < picked.length; round += 1) {
    for (const [index, queue] of queues.entries()) {
      const row = queue[round];
      if (row) {
        ranked.push({ row, topic: TOPICS[index] as Topic });
      }
    }
  }
  return ranked;
}

/** Everything a re-run needs once the production stream has expired. Raw customer data: `.eve/` only. */
export const liveSnapshotSchema = z.strictObject({
  /** The original investigation's tool calls, as the session stream recorded them. */
  cassette: widgetCaseSchema.shape.cassette,
  question: z.string().min(1),
  reply: z.string().nullable(),
  runId: z.string().regex(/^wrun_[0-9A-Z]{26}$/),
  /** The verified scope production ran with, including any recordingId. */
  scope: widgetContextSchema,
  sentAt: z.iso.datetime(),
  topic: z.enum(TOPICS),
});
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;
export const liveSetSchema = z.strictObject({
  cases: z.array(liveSnapshotSchema).min(1),
  pickedAt: z.iso.datetime(),
});
export type LiveSet = z.infer<typeof liveSetSchema>;

/**
 * Expectation-free claims. "Answered what was needed" has no authored claims
 * to read, so it is this one claim (plus context and reask on a later turn).
 */
export const LIVE_ANSWERED =
  "The message answers what the customer asked, or asks one clarifying question that the tool results justify when the request is ambiguous.";

/**
 * Decides the handoff expectation for a live run from the question and tool
 * results alone, so "handed off only when needed" needs no authored lane.
 */
export const NEEDS_HUMAN: Claim = {
  id: "needs_human",
  text: "Judging only the customer's messages and the tool results, not the answer: the customer asked for a person, or the tool results show the fix needs the Acquisity team (a refund, a billing correction, or a fault the customer cannot repair).",
};

/** A live run as a case: the question, the run's own tool results, and no authored expectations. */
export const liveCase = (
  input: Pick<WidgetCase, "cassette" | "question" | "scope"> & {
    runId: string;
  },
  needsHuman = false
): WidgetCase =>
  widgetCaseSchema.parse({
    cassette: input.cassette,
    expectations: {
      cause: null,
      claims: [LIVE_ANSWERED],
      fileTicket: null,
      foreignIdentifiers: [],
      gateVerdict: null,
      lane: needsHuman ? "human" : null,
      toolBudget: null,
    },
    mode: "investigate",
    question: input.question,
    scope: input.scope,
    source: { runId: input.runId, target: "local" },
    tags: {
      lane: "investigate",
      role: input.scope.role,
      safety: [],
      tools: [...new Set(input.cassette.map(({ tool }) => tool))],
    },
  });

/** The judge's needs_human verdict split from the claims the scorecard reads. */
export function splitNeedsHuman(verdicts: Verdict[]) {
  const needs = verdicts.find(({ id }) => id === NEEDS_HUMAN.id);
  return {
    needsHuman: needs ? needs.verdict === "yes" : undefined,
    reason: needs?.reason ?? null,
    verdicts: verdicts.filter(({ id }) => id !== NEEDS_HUMAN.id),
  };
}

/** Graded from the evidence read, not an authored cause: never the replay goal. */
export const LIVE_CAUSE_GOAL = "conclusion supported by the evidence read";
export const LIVE_TARGETS: Partial<Record<string, number>> = {
  ...SCORECARD_TARGETS,
  [LIVE_CAUSE_GOAL]: SCORECARD_TARGETS["found the real cause"],
};

/** The replay scorecard relabeled for live runs; per-cause-type rows need authored cause types, so they go. */
export const liveScorecard = (card: ReturnType<typeof scorecard>) => ({
  ...card,
  rates: card.rates
    .filter(({ goal }) => !goal.startsWith("answered what was needed ("))
    .map((rate) =>
      rate.goal === "found the real cause"
        ? { ...rate, goal: LIVE_CAUSE_GOAL }
        : rate
    ),
});

/** One case of the review export: scrubbed text only. */
export interface ConversationExport {
  customer: { role: string; text: string }[];
  liveReply: string | null;
  newToolCalls: string[];
  originalReply: string | null;
  originalToolCalls: string[];
  runId: string;
  topic: Topic;
  verdicts: { goal: string; reason: string; verdict: string }[];
}

/** The judge's verdicts in a record, for the export. */
export const exportVerdicts = (
  record: JudgeRecord | null,
  needsHuman: { reason: string | null; value: boolean | undefined }
) => [
  ...(record?.verdicts.map(({ id, reason, verdict }) => ({
    goal: id === "cause" ? LIVE_CAUSE_GOAL : id,
    reason,
    verdict,
  })) ?? []),
  ...(needsHuman.value === undefined
    ? []
    : [
        {
          goal: NEEDS_HUMAN.id,
          reason: needsHuman.reason ?? "",
          verdict: needsHuman.value ? "yes" : "no",
        },
      ]),
];
