import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gateway, generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getHelpArticleContent, helpArticleSlug } from "./help-center.js";
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

/**
 * One answer sentence saying something could not be confirmed, checked or was
 * not available, sorted by why (ENG-15024). A tool gap names the capability a
 * widget tool would need; the admission itself is never suppressed.
 */
const gapSchema = z.strictObject({
  capability: z.string().nullable(),
  kind: z.enum(["tool_gap", "tool_failure", "real_unknown"]),
  sentence: z.string(),
});
export type Gap = z.infer<typeof gapSchema>;

/** The exact reviewed sample, including the scrubbed case snapshot and its source. */
export const judgeRecordSchema = z
  .strictObject({
    answer: z.string().min(1),
    case: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    // Absent on records judged before ENG-15024.
    gaps: z.array(gapSchema).optional(),
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
  verdicts: Verdict[],
  gaps?: Gap[]
): JudgeRecord {
  const claims = claimsFor(recorded);
  return judgeRecordSchema.parse({
    answer,
    case: name,
    gaps,
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
    text: "The message invents no Acquisity product fact (a feature, page, setting, plan, price or limit that neither the tool results, the conversation nor a cited help-center article supports) and promises nothing about what Acquisity or its team will do.",
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
// Aaron, 2026-10-09: a diagnosis alone does not answer a user error or a limitation.
const FIX: Claim = {
  id: "fix",
  text: "The message gives the customer the product steps that fix the problem, or the workaround, not only the diagnosis.",
};
const LIMITED: Claim = {
  id: "member",
  text: "Every statement is supported by a cited help article and no account data appears.",
};

/** The shared claims for an answered case, then the case's own. */
export function claimsFor(recorded: WidgetCase): Claim[] {
  const { cause, causeType, claims } = recorded.expectations;
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
    ...(causeType === "user_error" || causeType === "platform_limitation"
      ? [FIX]
      : []),
    ...(toRequest(recorded.question).history?.length ? CONVERSATION : []),
    ...claims.map((text, n) => ({ id: `case-${n + 1}`, text })),
  ];
}

const JUDGE_PROMPT = `You check one customer support answer against a list of claims.
The tool results are the ground truth for the customer's account. The customer cannot see them.
For each claim, answer yes only when the claim holds for the answer, and no otherwise. Give a one-line reason that points at the sentence or tool result that decides it.
Internal jargon means words a customer would not know: raw field names, status codes, database or vendor names, ticket ids, or tool names.
Return exactly one verdict per claim id, in the order given.
citedArticles is the text of the help-center articles the answer cited; a fact one of them states is supported only for the situation the article states it for, so an article sentence applied to a different situation is unsupported. An Acquisity product fact no cited article, tool result or conversation turn states is unsupported.
widgetAffordances are real parts of the support widget the answer may mention.
In gaps, list every answer sentence that says something could not be confirmed, checked or found, or was not available, with its kind: tool_gap when no tool result covers that data (no widget tool read it), tool_failure when a tool that reads it errored or came back empty, real_unknown when the data does not exist. For a tool_gap, capability is a short generic name for the kind of data no tool read, such as "campaign sequence content", never a specific record, campaign or person; otherwise null. An answer with no such sentence has an empty list.`;

/** The support widget's own affordances the judge may treat as real. Nothing else. */
const WIDGET_AFFORDANCES = [
  "The magnifying glass next to the message box, for owners and admins, starts a look at their workspace.",
  "The AI Consultant is under the Chat toggle at the top of the left sidebar.",
  'The "Report a problem" link.',
];

/**
 * Every help-center article fits whole (the longest was 17,297 characters on
 * 2026-10-08). At 8,000 the judge flagged true facts that sat past the cut in
 * the very article a reply cited (ENG-14932 round 3).
 */
const MAX_ARTICLE_CHARS = 40_000;

export interface CitedArticle {
  content: string;
  title?: string;
  url: string;
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/u;
const MDX_IMPORTS = /^(import|export) .*$/gmu;
const TITLE = /^title:\s*["']?(.*?)["']?\s*$/mu;

/**
 * One article from a local copy of apps/web/content/docs (WIDGET_JUDGE_DOCS),
 * so the judge can read the docs a change is built from before they ship.
 */
function localArticle(url: string, docs: string) {
  const slug = helpArticleSlug(url);
  const path = [`${docs}/${slug}.mdx`, `${docs}/${slug}/index.mdx`].find(
    (candidate) => slug && existsSync(candidate)
  );
  if (!path) {
    return { error: "Article not found.", url };
  }
  const raw = readFileSync(path, "utf8");
  return {
    content: raw.replace(FRONTMATTER, "").replace(MDX_IMPORTS, "").trim(),
    title: raw.match(TITLE)?.[1],
    url: `/docs/${slug}`,
  };
}

/**
 * The text of each cited help-center article; an unreadable one is left out.
 * Live from the help center unless WIDGET_JUDGE_DOCS names a local docs folder.
 * WIDGET_JUDGE_NAV names a file holding the app's navigation as checked in the
 * real app (the product guide's sidebar map); it is added as one more source,
 * so a path it supports is not counted as invented.
 */
export async function citedArticles(
  urls: readonly string[],
  opts?: Parameters<typeof getHelpArticleContent>[1]
): Promise<CitedArticle[]> {
  const docs = process.env.WIDGET_JUDGE_DOCS;
  const read = await Promise.all(
    [...new Set(urls)].map((url) =>
      docs ? localArticle(url, docs) : getHelpArticleContent(url, opts)
    )
  );
  const nav = process.env.WIDGET_JUDGE_NAV;
  return [
    ...read.flatMap((article) =>
      "error" in article
        ? []
        : [{ ...article, content: article.content.slice(0, MAX_ARTICLE_CHARS) }]
    ),
    ...(nav
      ? [
          {
            content: readFileSync(nav, "utf8").slice(0, MAX_ARTICLE_CHARS),
            title: "App navigation (sidebar and menus)",
            url: "/docs",
          },
        ]
      : []),
  ];
}

/** The judge's user message: the answer, its claims and every piece of evidence it may rely on. */
export const judgeInput = (
  recorded: WidgetCase,
  answer: string,
  claims: Claim[],
  articles: CitedArticle[] = []
) =>
  JSON.stringify({
    answer,
    citedArticles: articles,
    claims,
    question: recorded.question,
    role: recorded.scope.role,
    toolResults: recorded.cassette.map(({ input, output, status, tool }) => ({
      input,
      output,
      status,
      tool,
    })),
    widgetAffordances: WIDGET_AFFORDANCES,
  });

const judgeSchema = z.strictObject({
  gaps: z.array(gapSchema),
  verdicts: z.array(verdictSchema),
});

export const JUDGE_TIMEOUT_MS = 60_000;

const MAX_REASON = 240;

/** Exactly one verdict per claim, in claim order, each reason one bounded line. */
export function parseVerdicts(claims: Claim[], raw: unknown): Verdict[] {
  const { verdicts } = z
    .object({ verdicts: judgeSchema.shape.verdicts })
    .parse(raw);
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

/** The judge's gap list, each sentence one bounded line. */
export const parseGaps = (raw: unknown): Gap[] =>
  z
    .object({ gaps: judgeSchema.shape.gaps })
    .parse(raw)
    .gaps.map((gap) => ({
      capability:
        gap.kind === "tool_gap" ? gap.capability?.trim() || "unnamed" : null,
      kind: gap.kind,
      sentence: gap.sentence.replace(/\s+/g, " ").trim().slice(0, MAX_REASON),
    }));

/** One judge call for one case's answer: a verdict per claim and the answer's gap sentences. */
export async function judgeAnswer(
  recorded: WidgetCase,
  answer: string,
  claims: Claim[],
  abortSignal?: AbortSignal,
  model: LanguageModel = gateway(JUDGE_MODEL),
  articles: CitedArticle[] = []
): Promise<{ gaps: Gap[]; verdicts: Verdict[] }> {
  const deadline = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  const { object } = await generateObject({
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, deadline])
      : deadline,
    model,
    prompt: judgeInput(recorded, answer, claims, articles),
    schema: judgeSchema,
    system: JUDGE_PROMPT,
  });
  return { gaps: parseGaps(object), verdicts: parseVerdicts(claims, object) };
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

/** What the replay eval's `row:` log line carries that the scorecard reads. */
export interface ReplayRow {
  budgetHit?: boolean;
  finalReplyMs?: number | null;
  firstReplyMs?: number | null;
  handedOff?: boolean;
  leaks?: string;
  rawFields?: string;
  scored?: boolean;
}

/** One replayed case of one run: its row, the case it replayed and the judge's record when the judge ran. */
export interface ScoredReplay {
  record: JudgeRecord | null;
  recorded: WidgetCase;
  row: ReplayRow;
}

/** Goals with an agreed target (a pass rate from 0 to 1). None is set yet (ENG-15024). */
export const SCORECARD_TARGETS: Partial<Record<string, number>> = {};

interface Rate {
  goal: string;
  pass: number;
  total: number;
}

const verdictOf = (record: JudgeRecord, id: string) =>
  record.verdicts.find((verdict) => verdict.id === id)?.verdict;

/** Nearest-rank percentile in seconds; null without samples. */
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return at === undefined ? null : at / 1000;
};

/**
 * The investigate scorecard (ENG-15024) as plain pass rates. Behavior goals
 * count only scored replays; leaks count every replay. "Answered what was
 * needed" is every case claim and the fix claim, overall and per cause type.
 */
export function scorecard(replays: readonly ScoredReplay[]) {
  const rates: Rate[] = [];
  const rate = (goal: string, outcomes: (boolean | undefined)[]) => {
    const known = outcomes.filter((ok) => ok !== undefined);
    rates.push({
      goal,
      pass: known.filter(Boolean).length,
      total: known.length,
    });
  };
  const scored = replays.filter(({ row }) => row.scored !== false);
  const judged = scored.flatMap(({ record }) => (record ? [record] : []));
  const answered = (record: JudgeRecord) => {
    const needed = record.verdicts.filter(
      ({ id }) => id === "fix" || id.startsWith("case-")
    );
    return needed.length
      ? needed.every(({ verdict }) => verdict === "yes")
      : undefined;
  };
  rate(
    "found the real cause",
    judged.map((record) => {
      const verdict = verdictOf(record, "cause");
      return verdict && verdict === "yes";
    })
  );
  rate(
    "nothing made up",
    judged.map(
      (record) =>
        verdictOf(record, "invented") === "yes" &&
        verdictOf(record, "facts") === "yes"
    )
  );
  rate("answered what was needed", judged.map(answered));
  for (const type of [
    "user_error",
    "platform_limitation",
    "bug",
    "unclear",
  ] as const) {
    rate(
      `answered what was needed (${type})`,
      judged
        .filter((record) => record.recorded.expectations.causeType === type)
        .map(answered)
    );
  }
  rate(
    "handed off only when needed",
    scored.map(({ recorded: { expectations }, row }) =>
      row.handedOff === undefined
        ? undefined
        : row.handedOff ===
          (expectations.lane === "human" || expectations.fileTicket === true)
    )
  );
  rate(
    "no leaks",
    replays.map(({ row }) => row.leaks === "pass" && row.rawFields === "pass")
  );
  rate(
    "stayed in budget",
    scored.map(({ row }) =>
      row.budgetHit === undefined ? undefined : !row.budgetHit
    )
  );
  rate(
    "no tool gaps",
    judged.map((record) =>
      record.gaps
        ? !record.gaps.some(({ kind }) => kind === "tool_gap")
        : undefined
    )
  );
  const times = (key: "finalReplyMs" | "firstReplyMs") =>
    replays.flatMap(({ row }) =>
      typeof row[key] === "number" ? [row[key]] : []
    );
  const gaps = new Map<string, number>();
  for (const gap of judged.flatMap((record) => record.gaps ?? [])) {
    if (gap.kind === "tool_gap") {
      const name = (gap.capability ?? "unnamed").toLowerCase();
      gaps.set(name, (gaps.get(name) ?? 0) + 1);
    }
  }
  return {
    gaps: [...gaps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    rates,
    replays: replays.length,
    replies: (["firstReplyMs", "finalReplyMs"] as const).map((key) => ({
      key: key === "firstReplyMs" ? "first reply" : "final reply",
      p50: percentile(times(key), 50),
      p90: percentile(times(key), 90),
      samples: times(key).length,
    })),
    scored: scored.length,
  };
}

/** The scorecard as text: one pass rate per goal, target and hit/miss only where a target is set. */
export function renderScorecard(card: ReturnType<typeof scorecard>) {
  const pct = (part: number, whole: number) =>
    whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
  const seconds = (value: number | null) =>
    value === null ? "n/a" : `${value.toFixed(1)}s`;
  return [
    `${card.replays} replays, ${card.scored} scored`,
    "",
    "| goal | pass rate | n | target | hit |",
    "| --- | --- | --- | --- | --- |",
    ...card.rates.map(({ goal, pass, total }) => {
      const target = SCORECARD_TARGETS[goal];
      if (target === undefined || !total) {
        return `| ${goal} | ${pct(pass, total)} | ${total} |  |  |`;
      }
      return `| ${goal} | ${pct(pass, total)} | ${total} | ${pct(target, 1)} | ${pass / total >= target ? "hit" : "miss"} |`;
    }),
    ...card.replies.map(
      (reply) =>
        `| reply time, ${reply.key} | p50 ${seconds(reply.p50)}, p90 ${seconds(reply.p90)} | ${reply.samples} |  |  |`
    ),
    "",
    "Tool gaps by missing capability:",
    ...(card.gaps.length
      ? card.gaps.map(([capability, count]) => `${count}  ${capability}`)
      : ["none"]),
    "",
  ].join("\n");
}
