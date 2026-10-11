import { z } from "zod";
import { type Candidate, parseExcludedOrgs } from "./widget-candidates.js";
import { type WidgetCase, widgetCaseSchema } from "./widget-case.js";
import { parseFindings } from "./widget-findings.js";
import {
  type Claim,
  CONCLUSION_CLAIM,
  claimsFor,
  type JudgeRecord,
  SCORECARD_TARGETS,
  type ScoredReplay,
  scorecard,
  type Verdict,
} from "./widget-judge.js";
import { gapSentences } from "./widget-live.js";
import { ELIGIBLE_INSTRUCTIONS } from "./widget-next-action.js";
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
  /** The original outcome's reason ("needs_human" is a handoff); absent on sets picked before it was kept. */
  reason: z.string().nullable().optional(),
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
 * results alone, so "handed off only when needed" needs no authored lane. It
 * quotes the product's own handoff rule so the grade cannot drift from it.
 */
export const NEEDS_HUMAN: Claim = {
  id: "needs_human",
  text: `Judging only the customer's messages and the tool results, not the answer, a person is needed only when this holds: ${ELIGIBLE_INSTRUCTIONS} A refund request on its own, a fault the customer cannot fix, and a billing correction the customer did not dispute are not this either: they are answered, and a refund request is filed to billing, not handed to a person.`,
};

/**
 * The causes Aaron labels while he reviews a set, in
 * `.eve/widget-live/sets/<name>/cause-labels.json` (ENG-15044 round 9). A
 * confirmed label grades "found the real cause"; a draft one only its own row;
 * an excluded case leaves the cause and answered rows.
 */
export const causeLabelSchema = z.object({
  cause: z.string().min(1),
  causeType: z.enum(["user_error", "platform_limitation", "bug", "unclear"]),
  /** What the reply should give the customer; it grades "answered what was needed". */
  correctReply: z.string().min(1).optional(),
  exclude: z.boolean().optional(),
  source: z.string(),
  status: z.enum(["confirmed", "draft"]),
});
export type CauseLabel = z.infer<typeof causeLabelSchema>;
export type CauseLabels = Record<string, CauseLabel>;
/** The labels by run id; a missing file is no labels. */
export const parseCauseLabels = (text: string | null): CauseLabels =>
  text === null
    ? {}
    : z
        .object({ labels: z.record(z.string(), causeLabelSchema) })
        .parse(JSON.parse(text)).labels;

/** A live run as a case: the question, the run's own tool results and its cause label, if any. */
export const liveCase = (
  input: Pick<WidgetCase, "cassette" | "question" | "scope"> & {
    runId: string;
  },
  needsHuman = false,
  label?: CauseLabel
): WidgetCase => {
  const graded = label && !label.exclude ? label : undefined;
  return widgetCaseSchema.parse({
    cassette: input.cassette,
    expectations: {
      cause: graded?.cause ?? null,
      ...(graded ? { causeType: graded.causeType } : {}),
      claims: [
        graded?.correctReply
          ? `The message gives the customer what they needed, as support describes it: ${graded.correctReply}`
          : LIVE_ANSWERED,
      ],
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
};

/**
 * With no labeled cause, the cause claim already asks for the conclusion the
 * evidence supports; a labeled case asks that separately, as this claim.
 */
export const SUPPORTED: Claim = { id: "supported", text: CONCLUSION_CLAIM };

/** The claims a live run is judged on, before needs_human. */
export const liveClaims = (recorded: WidgetCase) => [
  ...claimsFor(recorded),
  ...(recorded.expectations.cause ? [SUPPORTED] : []),
];

/**
 * A saved record's verdicts that still hold for this case. A changed cause
 * label drops the cause verdict, and a changed case claim (a label's
 * correctReply) drops that claim's verdict; an unlabeled record's cause
 * verdict was the evidence-read conclusion, so it carries over as that.
 */
export function carriedVerdicts(old: JudgeRecord | null, recorded: WidgetCase) {
  const carried = new Map<string, Verdict>(
    (old?.verdicts ?? []).map(({ id, reason, verdict }) => [
      id,
      { id, reason, verdict },
    ])
  );
  const oldCause = old?.recorded.expectations.cause ?? null;
  if (oldCause !== recorded.expectations.cause) {
    const conclusion = carried.get("cause");
    if (oldCause === null && conclusion) {
      carried.set(SUPPORTED.id, { ...conclusion, id: SUPPORTED.id });
    }
    carried.delete("cause");
  }
  recorded.expectations.claims.forEach((text, n) => {
    if (old?.recorded.expectations.claims[n] !== text) {
      carried.delete(`case-${n + 1}`);
    }
  });
  return carried;
}

/**
 * The claims a rejudge asks again: any with no carried verdict, and the forced
 * ones. Unlabeled, the cause claim is the conclusion, which "supported" forces.
 */
export const rejudgedClaims = (
  claims: Claim[],
  carried: Map<string, Verdict>,
  forced: Set<string>,
  recorded: WidgetCase
) =>
  claims.filter(
    ({ id }) =>
      !carried.has(id) ||
      (forced.has(id) &&
        (id !== "cause" || Boolean(recorded.expectations.cause)))
  );

/** The judge's needs_human verdict split from the claims the scorecard reads. */
export function splitNeedsHuman(verdicts: Verdict[]) {
  const needs = verdicts.find(({ id }) => id === NEEDS_HUMAN.id);
  return {
    needsHuman: needs ? needs.verdict === "yes" : undefined,
    reason: needs?.reason ?? null,
    verdicts: verdicts.filter(({ id }) => id !== NEEDS_HUMAN.id),
  };
}

/** Graded from the evidence read, not a labeled cause; it has no target. */
export const LIVE_CAUSE_GOAL = "conclusion supported by the evidence read";
export const DRAFT_CAUSE_GOAL = "found the real cause (draft labels)";

/** The evidence-read verdict: its own claim on a labeled case, else the unlabeled cause claim. */
const conclusionVerdict = (record: JudgeRecord) =>
  record.verdicts.find(({ id }) => id === SUPPORTED.id)?.verdict ??
  (record.recorded.expectations.cause === null
    ? record.verdicts.find(({ id }) => id === "cause")?.verdict
    : undefined);

/**
 * The replay scorecard for live runs. "Found the real cause" counts confirmed,
 * non-excluded labels only; draft labels get their own row; excluded cases
 * leave the cause and answered rows; the conclusion row covers every case.
 */
export function liveScorecard(
  replays: readonly ScoredReplay[],
  labels: CauseLabels
) {
  const labelOf = ({ recorded }: ScoredReplay) =>
    labels[recorded.source.runId ?? ""];
  const kept = replays.filter((replay) => !labelOf(replay)?.exclude);
  const all = scorecard(replays);
  const answered = scorecard(kept).rates.filter(({ goal }) =>
    goal.startsWith("answered what was needed")
  );
  const cause = (status: CauseLabel["status"], goal: string) => {
    const rate = scorecard(
      kept.filter((replay) => labelOf(replay)?.status === status)
    ).rates.find((entry) => entry.goal === "found the real cause");
    return { goal, pass: rate?.pass ?? 0, total: rate?.total ?? 0 };
  };
  const scored = replays.filter(({ row }) => row.scored !== false);
  const conclusions = scored.map(({ record, recorded, row }) => {
    if (!record) {
      return row.answer === null
        ? row.handedOff === true && recorded.expectations.lane === "human"
        : undefined;
    }
    const verdict = conclusionVerdict(record);
    return verdict === undefined ? undefined : verdict === "yes";
  });
  const rest = (goals: string[]) =>
    all.rates.filter(({ goal }) => goals.includes(goal));
  return {
    ...all,
    labels: {
      confirmed: kept.filter(
        (replay) => labelOf(replay)?.status === "confirmed"
      ).length,
      draft: kept.filter((replay) => labelOf(replay)?.status === "draft")
        .length,
      excluded: replays.length - kept.length,
      unlabeled: replays.filter((replay) => !labelOf(replay)).length,
    },
    rates: [
      cause("confirmed", "found the real cause"),
      cause("draft", DRAFT_CAUSE_GOAL),
      {
        goal: LIVE_CAUSE_GOAL,
        pass: conclusions.filter((ok) => ok === true).length,
        total: conclusions.length,
      },
      ...rest(["nothing made up"]),
      ...answered,
      ...rest([
        "handed off only when needed",
        "no leaks",
        "stayed in budget",
        "no tool gaps",
      ]),
    ],
  };
}

/** How many cases each kind of label covers; unlabeled cases get no cause verdict. */
export const labelLine = ({ labels }: ReturnType<typeof liveScorecard>) =>
  `Cause labels: ${labels.confirmed} confirmed, ${labels.draft} draft, ${labels.excluded} excluded, ${labels.unlabeled} unlabeled (no cause verdict).`;

/** One case of the review export: scrubbed text only. */
export interface ConversationExport {
  customer: { role: string; text: string }[];
  liveReply: string | null;
  newToolCalls: string[];
  originalReply: string | null;
  originalToolCalls: string[];
  /** The same judge on the original production reply and its own tool results. */
  originalVerdicts: { goal: string; reason: string; verdict: string }[];
  runId: string;
  topic: Topic;
  verdicts: { goal: string; reason: string; verdict: string }[];
}

/**
 * Production (what the customer got) beside live at HEAD, one row per goal.
 * A cell is the pass rate and its n; hit or miss only where a target is set
 * and the column has full judge coverage.
 */
export function twoColumnScorecard(
  production: ReturnType<typeof liveScorecard>,
  live: ReturnType<typeof liveScorecard>,
  targets = SCORECARD_TARGETS
) {
  const cell = (card: typeof live, goal: string) => {
    const rate = card.rates.find((entry) => entry.goal === goal);
    if (!rate?.total) {
      return "n/a";
    }
    const target = targets[goal];
    let mark = "";
    if (target !== undefined && card.missingCoverage === 0) {
      mark = rate.pass / rate.total >= target ? ", hit" : ", miss";
    }
    return `${((rate.pass / rate.total) * 100).toFixed(1)}% of ${rate.total}${mark}`;
  };
  const time = (card: typeof live, key: string) => {
    const reply = card.replies.find((entry) => entry.key === key);
    return typeof reply?.p50 !== "number" || typeof reply.p90 !== "number"
      ? "n/a"
      : `p50 ${reply.p50.toFixed(1)}s, p90 ${reply.p90.toFixed(1)}s`;
  };
  return [
    `Judged: production ${production.scored} (${production.missingCoverage} missing coverage), live ${live.scored} (${live.missingCoverage} missing coverage)`,
    "",
    "| goal | production | live at HEAD | target |",
    "| --- | --- | --- | --- |",
    ...live.rates.map(({ goal }) => {
      const target = targets[goal];
      return `| ${goal} | ${cell(production, goal)} | ${cell(live, goal)} | ${target === undefined ? "" : `${(target * 100).toFixed(1)}%`} |`;
    }),
    ...live.replies.map(
      ({ key }) =>
        `| reply time, ${key} | ${time(production, key)} | ${time(live, key)} |  |`
    ),
  ].join("\n");
}

/** The judge's verdicts in a record, for the export. */
export const exportVerdicts = (
  record: JudgeRecord | null,
  needsHuman: { reason: string | null; value: boolean | undefined }
) => [
  ...(record?.verdicts.map(({ id, reason, verdict }) => ({
    goal:
      id === SUPPORTED.id ||
      (id === "cause" && !record?.recorded.expectations.cause)
        ? LIVE_CAUSE_GOAL
        : id,
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
