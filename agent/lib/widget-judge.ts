import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gateway, generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { toRequest, type WidgetCase, widgetCaseSchema } from "./widget-case.js";

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

const verdictSchema = z.strictObject({
  id: z.string().min(1),
  reason: z.string(),
  verdict: z.enum(["yes", "no"]),
});

/** The exact reviewed sample, including the scrubbed case snapshot and its source. */
export const judgeRecordSchema = z
  .strictObject({
    answer: z.string().min(1),
    case: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    judgedAt: z.iso.datetime(),
    model: z.string().min(1),
    recorded: widgetCaseSchema,
    verdicts: z
      .array(verdictSchema.extend({ claim: z.string().min(1) }))
      .min(1),
  })
  .superRefine((record, ctx) => {
    if (
      new Set(record.verdicts.map((v) => v.id)).size !== record.verdicts.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate reviewed claim ids.",
      });
    }
  });
export type JudgeRecord = z.infer<typeof judgeRecordSchema>;

/** Build the sample once; review, export and calibration consume this same record. */
export function reviewedSample(
  name: string,
  recorded: WidgetCase,
  answer: string,
  verdicts: Verdict[]
): JudgeRecord {
  const claims = claimsFor(recorded);
  return judgeRecordSchema.parse({
    answer,
    case: name,
    judgedAt: new Date().toISOString(),
    model: JUDGE_MODEL,
    recorded,
    verdicts: parseVerdicts(claims, { verdicts }).map((v, n) => ({
      ...v,
      claim: claims[n]?.text,
    })),
  });
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
  // Aaron, 2026-10-05: unrequested "what I could not check" lines are verbosity.
  {
    id: "caveats",
    text: "The message mentions something that could not be checked only when the customer asked about that thing.",
  },
  // ENG-14931: must hold on every case.
  {
    id: "invented",
    text: "The message invents no Acquisity product fact (a feature, page, setting, plan, price or limit that neither the tool results, the conversation nor a help-center link in the message supports) and promises nothing about what Acquisity or its team will do.",
  },
];
/** Only a case with earlier turns can re-ask or lose the thread. */
const CONVERSATION: Claim[] = [
  {
    id: "reask",
    text: "The message does not ask for a detail the customer already gave in the earlier turns, such as which feature, page, campaign or plan they mean.",
  },
  {
    id: "context",
    text: "The message answers the latest customer message, reading the earlier turns only to resolve what it refers to.",
  },
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
      // Null means no authored cause, not a label saying no cause was found.
      text: cause
        ? `The message names the expected cause (${cause}), or says plainly that it could not find one when that is what the case expects.`
        : "The answer draws the conclusion warranted by the question and tool results, including a justified clarifying question when the subject is ambiguous or explicit uncertainty when a cause cannot be established.",
    },
    ...SHARED,
    ...(limited ? [LIMITED] : []),
    ...(toRequest(recorded.question).history?.length ? CONVERSATION : []),
    ...claims.map((text, n) => ({ id: `case-${n + 1}`, text })),
  ];
}

const JUDGE_PROMPT = `You check one customer support answer against a list of claims.
The tool results are the ground truth for the customer's account. The customer cannot see them.
For each claim, answer yes only when the claim holds for the answer, and no otherwise. Give a one-line reason that points at the sentence or tool result that decides it.
Internal jargon means words a customer would not know: raw field names, status codes, database or vendor names, ticket ids, or tool names.
Return exactly one verdict per claim id, in the order given.`;

const judgeSchema = z.strictObject({ verdicts: z.array(verdictSchema) });

export const JUDGE_TIMEOUT_MS = 60_000;

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
  abortSignal?: AbortSignal,
  model: LanguageModel = gateway(JUDGE_MODEL)
): Promise<Verdict[]> {
  const deadline = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  const { object } = await generateObject({
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, deadline])
      : deadline,
    model,
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
    .map((file) =>
      judgeRecordSchema.parse(
        JSON.parse(readFileSync(`${dir}/records/${file}`, "utf8"))
      )
    );

/** Save one case's record and regenerate the run's review page from every record so far. */
export function saveRecord(dir: string, input: JudgeRecord) {
  const record = judgeRecordSchema.parse(input);
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
const codeBlock = (text: string, language = "text") => {
  const fence = "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1))
  );
  return `${fence}${language}\n${text}\n${fence}`;
};

export function renderReview(records: JudgeRecord[]): string {
  const sections = records.map((input) => {
    const record = judgeRecordSchema.parse(input);
    const rows = record.verdicts.map(
      (verdict) =>
        `| ${record.case}#${verdict.id} | ${cell(verdict.claim)} | ${verdict.verdict} | ${cell(verdict.reason)} |  |`
    );
    return [
      `## ${record.case}`,
      "",
      `Judged ${record.judgedAt} by ${record.model}.`,
      "",
      `Role: ${record.recorded.scope.role}. Authored cause: ${record.recorded.expectations.cause ?? "unset (not a no-cause label)"}.`,
      "",
      "Question:",
      codeBlock(record.recorded.question),
      "",
      "<details>",
      "<summary>Scrubbed cassette evidence and source</summary>",
      "",
      codeBlock(
        JSON.stringify(
          {
            cassette: record.recorded.cassette,
            source: record.recorded.source,
          },
          null,
          2
        ),
        "json"
      ),
      "",
      "</details>",
      "",
      "Answer:",
      codeBlock(record.answer),
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
    sections.join("\n\n"),
    "",
  ].join("\n");
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
    if (marks.has(match[1] as string)) {
      throw new Error(`${match[1]} is marked more than once.`);
    }
    marks.set(match[1] as string, mark === "right");
  }
  return marks;
}
