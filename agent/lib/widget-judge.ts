import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gateway, generateObject } from "ai";
import { z } from "zod";
import type { WidgetCase } from "./widget-case.js";

/**
 * The claims judge's model. The widget writes with anthropic/claude-sonnet-5
 * and its egress gate reviews with openai/gpt-5.6-sol, so the judge is a tier
 * above both and from neither the gate's vendor nor the composer's model:
 * Opus 5.5 is the strongest Anthropic model the gateway serves, at the gate's
 * price ($4/$20 per million tokens on 2026-10-04). A change here reruns
 * against the gold file first (`pnpm widget:judge rerun`).
 */
export const JUDGE_MODEL = "anthropic/claude-opus-5.5";

export interface Claim {
  /** Stable across runs: a shared claim's name, or `case-<n>` for a case's own claim. */
  id: string;
  text: string;
}

export interface Verdict {
  id: string;
  reason: string;
  verdict: "yes" | "no";
}

/** One judged case as the eval writes it; the review page and the gold file read these. */
export interface JudgeRecord {
  answer: string;
  case: string;
  judgedAt: string;
  model: string;
  verdicts: (Verdict & { claim: string })[];
}

export interface GoldEntry {
  answer: string;
  case: string;
  claims: { claim: string; expected: "yes" | "no"; id: string }[];
}

const SHARED: Claim[] = [
  {
    id: "actions",
    text: "Every action the message tells the customer to take is possible given the tool results.",
  },
  {
    id: "facts",
    text: "The message states no fact that contradicts a tool result.",
  },
  { id: "steps", text: "Steps are one per line." },
  { id: "jargon", text: "The message uses no internal jargon." },
];
const LIMITED: Claim = {
  id: "member",
  text: "Every statement is supported by a cited help article and no account data appears.",
};

/** The shared claims for an answered case, then the case's own. */
export function claimsFor(recorded: WidgetCase): Claim[] {
  const { cause, claims } = recorded.expectations;
  const limited =
    recorded.scope.role === "member" || recorded.scope.role === "client";
  return [
    {
      id: "cause",
      // An unset cause is judged against the tool results instead of skipped.
      text: cause
        ? `The message names the expected cause (${cause}), or says plainly that it could not find one when that is what the case expects.`
        : "The message names the cause the tool results support, or says plainly that it could not find one when they support none.",
    },
    ...SHARED,
    ...(limited ? [LIMITED] : []),
    ...claims.map((text, n) => ({ id: `case-${n + 1}`, text })),
  ];
}

const JUDGE_PROMPT = `You check one customer support answer against a list of claims.
The tool results are the ground truth for the customer's account. The customer cannot see them.
For each claim, answer yes only when the claim holds for the answer, and no otherwise. Give a one-line reason that points at the sentence or tool result that decides it.
Internal jargon means words a customer would not know: raw field names, status codes, database or vendor names, ticket ids, or tool names.
Return exactly one verdict per claim id, in the order given.`;

const judgeSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      verdict: z.enum(["yes", "no"]),
    })
  ),
});

const MAX_REASON = 240;

/** Exactly one verdict per claim, in claim order, each reason one bounded line. */
export function parseVerdicts(claims: Claim[], raw: unknown): Verdict[] {
  const { verdicts } = judgeSchema.parse(raw);
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const extra = verdicts.filter(
    (verdict) => !claims.some((claim) => claim.id === verdict.id)
  );
  if (byId.size !== verdicts.length || extra.length) {
    throw new Error("The judge returned duplicate or unknown claim ids.");
  }
  return claims.map((claim) => {
    const verdict = byId.get(claim.id);
    if (!verdict) {
      throw new Error(`The judge returned no verdict for ${claim.id}.`);
    }
    return {
      ...verdict,
      reason: verdict.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON),
    };
  });
}

/** One judge call for one case's answer. */
export async function judgeAnswer(
  recorded: WidgetCase,
  answer: string,
  claims: Claim[],
  abortSignal?: AbortSignal
): Promise<Verdict[]> {
  const { object } = await generateObject({
    abortSignal,
    model: gateway(JUDGE_MODEL),
    prompt: JSON.stringify({
      answer,
      claims,
      question: recorded.question,
      role: recorded.scope.role,
      toolResults: recorded.cassette.map(({ input, output, status, tool }) => ({
        input,
        output,
        status,
        tool,
      })),
    }),
    schema: judgeSchema,
    system: JUDGE_PROMPT,
  });
  return parseVerdicts(claims, object);
}

/** Ignored output root; each eval invocation writes `<root>/<timestamp>/`. */
export const JUDGE_OUTPUT = ".eve/widget-judge";

export const readRecords = (dir: string): JudgeRecord[] =>
  readdirSync(`${dir}/records`)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(`${dir}/records/${file}`, "utf8")));

/** Save one case's record and regenerate the run's review page from every record so far. */
export function saveRecord(dir: string, record: JudgeRecord) {
  mkdirSync(`${dir}/records`, { recursive: true });
  writeFileSync(
    `${dir}/records/${record.case}.json`,
    `${JSON.stringify(record, null, 2)}\n`
  );
  writeFileSync(`${dir}/review.md`, renderReview(readRecords(dir)));
}

const cell = (text: string) =>
  text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** The review page: each case's answer, then one row per claim with an empty mark column. */
export function renderReview(records: JudgeRecord[]): string {
  const sections = records.map((record) => {
    const rows = record.verdicts.map(
      (verdict) =>
        `| ${record.case}#${verdict.id} | ${cell(verdict.claim)} | ${verdict.verdict} | ${cell(verdict.reason)} |  |`
    );
    return [
      `## ${record.case}`,
      "",
      `Judged ${record.judgedAt} by ${record.model}.`,
      "",
      "```text",
      record.answer.replace(/```/g, "'''"),
      "```",
      "",
      "| key | claim | verdict | reason | mark |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  });
  return [
    "# Widget claims judge review",
    "",
    "Write right or wrong in the mark column of each row, then run `pnpm widget:judge gold <this directory>`.",
    "",
    ...sections,
    "",
  ].join("\n\n");
}

const ROW = /^\|\s*([^|\s]+#[^|\s]+)\s*\|.*\|\s*([^|]*?)\s*\|\s*$/;

/** The marks Aaron wrote, by row key; blank rows are left out. */
export function parseMarks(review: string): Map<string, boolean> {
  const marks = new Map<string, boolean>();
  for (const line of review.split("\n")) {
    const match = ROW.exec(line);
    const mark = match?.[2]?.toLowerCase();
    if (!(match && mark)) {
      continue;
    }
    if (mark !== "right" && mark !== "wrong") {
      throw new Error(
        `Mark "${match[2]}" on ${match[1]} is not right or wrong.`
      );
    }
    marks.set(match[1] as string, mark === "right");
  }
  return marks;
}

/** A marked verdict becomes its expected answer: kept when right, flipped when wrong. */
export function toGold(
  records: JudgeRecord[],
  marks: Map<string, boolean>
): GoldEntry[] {
  return records.flatMap((record) => {
    const claims = record.verdicts.flatMap((verdict) => {
      const right = marks.get(`${record.case}#${verdict.id}`);
      if (right === undefined) {
        return [];
      }
      const flipped = verdict.verdict === "yes" ? "no" : "yes";
      return [
        {
          claim: verdict.claim,
          expected: right ? verdict.verdict : flipped,
          id: verdict.id,
        },
      ];
    });
    return claims.length
      ? [{ answer: record.answer, case: record.case, claims }]
      : [];
  });
}

/** New entries replace a case's old entry; other cases stay. */
export const mergeGold = (old: GoldEntry[], next: GoldEntry[]) => [
  ...old.filter((entry) => !next.some((item) => item.case === entry.case)),
  ...next,
];

export interface ClaimScore {
  /** Verdicts matching gold, over gold labels whose claim wording is unchanged. */
  agreement: { agree: number; total: number };
  /** Verdicts that differ between the two runs. */
  flips: { flipped: number; total: number };
  /** Gold labels skipped because the claim was reworded since labelling. */
  stale: number;
}

/**
 * Per-claim agreement of two judge runs with the gold file, and their flip
 * rate. Each run maps `case` to its verdicts for the gold answer.
 */
export function scoreAgainstGold(
  gold: GoldEntry[],
  first: Map<string, (Verdict & { claim: string })[]>,
  second: Map<string, (Verdict & { claim: string })[]>
): Map<string, ClaimScore> {
  const scores = new Map<string, ClaimScore>();
  const score = (id: string) => {
    let entry = scores.get(id);
    if (!entry) {
      entry = {
        agreement: { agree: 0, total: 0 },
        flips: { flipped: 0, total: 0 },
        stale: 0,
      };
      scores.set(id, entry);
    }
    return entry;
  };
  for (const entry of gold) {
    for (const label of entry.claims) {
      const runs = [first, second].map((run) =>
        run.get(entry.case)?.find((verdict) => verdict.id === label.id)
      );
      const [a, b] = runs;
      if (!(a && b) || a.claim !== label.claim || b.claim !== label.claim) {
        score(label.id).stale += 1;
        continue;
      }
      const target = score(label.id);
      for (const verdict of runs) {
        target.agreement.total += 1;
        target.agreement.agree += verdict?.verdict === label.expected ? 1 : 0;
      }
      target.flips.total += 1;
      target.flips.flipped += a.verdict === b.verdict ? 0 : 1;
    }
  }
  return scores;
}
