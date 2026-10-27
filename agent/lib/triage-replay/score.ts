import { z } from "zod";
import {
  NEW_MASTER,
  type TriageCase,
  type TriageLabel,
  type TriageResult,
  UNKNOWN_COMMIT,
} from "./schema.js";

export const splitSchema = z.strictObject({
  groups: z.record(z.string(), z.unknown()),
  heldout: z.array(z.string()),
  rule: z.string().optional(),
  train: z.array(z.string()),
});
export type Split = z.infer<typeof splitSchema>;

export const rowKey = (caseId: string, run: number) => `${caseId}#${run}`;

const FIELDS = [
  "verdict",
  "classification",
  "path",
  "project",
  "owner",
  "duplicate",
  "master",
] as const;
type Field = (typeof FIELDS)[number];

export const COMPLETION = [
  "completed",
  "failed",
  "cancelled",
  "missing",
] as const;
type Completion = (typeof COMPLETION)[number];

export interface Tally {
  correct: number;
  total: number;
}

export interface GroupScore {
  completion: Record<Completion, number>;
  evidenceMisses: { reads: number; rows: number };
  fields: Record<Field, Tally>;
  insufficient: number;
  rows: number;
}

export interface SplitScore {
  all: GroupScore;
  lanes: Record<string, GroupScore>;
}

export interface ScoreReport {
  foremanCommit: string | null;
  runId: string | null;
  runs: number;
  splits: Record<"heldout" | "train", SplitScore>;
}

export interface ScoreInput {
  cases: readonly TriageCase[];
  heldoutLabels: readonly TriageLabel[];
  results: readonly TriageResult[];
  runs?: number;
  split: Split;
  trainLabels: readonly TriageLabel[];
}

const WHITESPACE = /\s+/g;
const LEADING_AT = /^@/;
const ID_SEPARATOR = /[\s,]+/;

const norm = (value: string | null) =>
  value === null
    ? null
    : value
        .trim()
        .replace(WHITESPACE, " ")
        .replace(LEADING_AT, "")
        .toLowerCase();

const sameText = (a: string | null, b: string | null) => norm(a) === norm(b);

const idSet = (ids: readonly string[]) =>
  new Set(ids.map((id) => id.trim().toUpperCase()).filter(Boolean));

export function sameDuplicates(
  label: readonly string[] | null,
  final: string | null
): boolean {
  const want = idSet(label ?? []);
  const got = idSet(final?.split(ID_SEPARATOR) ?? []);
  return want.size === got.size && [...want].every((id) => got.has(id));
}

const ISSUE_NUMBER = /-(\d+)$/u;
const issueNumber = (id: string) => Number(ISSUE_NUMBER.exec(id)?.[1] ?? 0);

export const expectedMaster = (label: TriageLabel): string | null => {
  if (!label.master) {
    return null;
  }
  return issueNumber(label.master) > issueNumber(label.id)
    ? NEW_MASTER
    : label.master;
};

const textMatch = (want: string | null, got: string | null) =>
  want === null ? null : sameText(want, got);

export function fieldMatches(
  label: TriageLabel,
  final: NonNullable<TriageResult["final"]>
): Record<Field, boolean | null> {
  return {
    classification: textMatch(label.classification, final.classification),
    duplicate: sameDuplicates(label.duplicateOf, final.duplicateOf),
    master: textMatch(expectedMaster(label), final.master),
    owner: textMatch(label.owner, final.assignee),
    path: textMatch(label.path, final.path),
    project: textMatch(label.project, final.project),
    verdict: label.verdict === final.outcome,
  };
}

const scoredFields = (label: TriageLabel): Field[] =>
  FIELDS.filter((field) => {
    switch (field) {
      case "classification":
        return label.classification !== null;
      case "master":
        return expectedMaster(label) !== null;
      case "owner":
        return label.owner !== null;
      case "path":
        return label.path !== null;
      case "project":
        return label.project !== null;
      default:
        return true;
    }
  });

const emptyGroup = (): GroupScore => ({
  completion: { cancelled: 0, completed: 0, failed: 0, missing: 0 },
  evidenceMisses: { reads: 0, rows: 0 },
  fields: Object.fromEntries(
    FIELDS.map((field) => [field, { correct: 0, total: 0 }])
  ) as Record<Field, Tally>,
  insufficient: 0,
  rows: 0,
});

function fail(message: string, ids: readonly string[] = []): never {
  throw new Error(
    ids.length ? `${message}: ${[...ids].sort().join(", ")}` : message
  );
}

function labelsFor(ids: readonly string[], labels: readonly TriageLabel[]) {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    fail("Split cases with no label", missing);
  }
  return byId;
}

export function checkScoreInput(input: ScoreInput): string | null {
  const caseIds = new Set(input.cases.map(({ id }) => id));
  const train = new Set(input.split.train);
  const heldout = new Set(input.split.heldout);
  const both = [...train].filter((id) => heldout.has(id));
  if (both.length) {
    fail("Cases in both train and held-out", both);
  }
  const unsplit = [...caseIds].filter(
    (id) => !(train.has(id) || heldout.has(id))
  );
  if (unsplit.length) {
    fail("Cohort cases missing from split.json", unsplit);
  }
  const unknown = [...train, ...heldout].filter((id) => !caseIds.has(id));
  if (unknown.length) {
    fail("split.json names cases outside the cohort", unknown);
  }
  const strays = input.results.filter(({ caseId }) => !caseIds.has(caseId));
  if (strays.length) {
    fail(
      "Results for cases outside the cohort",
      strays.map(({ caseId }) => caseId)
    );
  }
  const { runs } = input;
  if (runs !== undefined) {
    if (!(Number.isInteger(runs) && runs >= 1)) {
      fail(`--runs must be a whole number of at least 1, got ${runs}`);
    }
    const beyond = input.results.filter((result) => result.run > runs);
    if (beyond.length) {
      fail(
        `Results for runs above --runs ${runs}`,
        beyond.map(({ caseId, run }) => rowKey(caseId, run))
      );
    }
  }
  const runIds = new Set(input.results.map(({ runId }) => runId));
  if (runIds.size > 1) {
    fail("Results come from more than one run id", [...runIds]);
  }
  const commits = new Set(
    input.results.map(({ foremanCommit }) => foremanCommit)
  );
  if (commits.has(UNKNOWN_COMMIT)) {
    fail(
      "Results with an unknown Foreman commit; set TRIAGE_REPLAY_COMMIT on the replay server",
      input.results
        .filter(({ foremanCommit }) => foremanCommit === UNKNOWN_COMMIT)
        .map(({ caseId, run }) => rowKey(caseId, run))
    );
  }
  if (commits.size > 1) {
    fail("Results come from more than one Foreman commit", [...commits]);
  }
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const { caseId, run } of input.results) {
    const key = rowKey(caseId, run);
    if (seen.has(key)) {
      duplicates.push(key);
    }
    seen.add(key);
  }
  if (duplicates.length) {
    fail("More than one result for the same case and run", duplicates);
  }
  const misplaced = [
    ...input.trainLabels.filter(({ id }) => !train.has(id)),
    ...input.heldoutLabels.filter(({ id }) => !heldout.has(id)),
  ].map(({ id }) => id);
  if (misplaced.length) {
    fail("Labels filed under the wrong split", misplaced);
  }
  labelsFor(input.split.train, input.trainLabels);
  labelsFor(input.split.heldout, input.heldoutLabels);
  return [...runIds][0] ?? null;
}

function addRow(
  group: GroupScore,
  label: TriageLabel,
  result: TriageResult | undefined
) {
  group.rows += 1;
  group.completion[result?.status ?? "missing"] += 1;
  if (result?.evidenceMisses.length) {
    group.evidenceMisses.rows += 1;
    group.evidenceMisses.reads += result.evidenceMisses.length;
  }
  if (label.insufficient) {
    group.insufficient += 1;
    return;
  }
  const scorable = result?.status === "completed" ? result.final : null;
  const matches = scorable ? fieldMatches(label, scorable) : null;
  for (const field of scoredFields(label)) {
    group.fields[field].total += 1;
    group.fields[field].correct += matches?.[field] ? 1 : 0;
  }
}

export function scoreReplay(input: ScoreInput): ScoreReport {
  const runId = checkScoreInput(input);
  const runs =
    input.runs ?? Math.max(1, ...input.results.map(({ run }) => run));
  const results = new Map(
    input.results.map((result) => [rowKey(result.caseId, result.run), result])
  );
  const lanes = new Map(input.cases.map((item) => [item.id, item.lane]));
  const score = (ids: readonly string[], labels: readonly TriageLabel[]) => {
    const byId = labelsFor(ids, labels);
    const split: SplitScore = { all: emptyGroup(), lanes: {} };
    for (const id of [...ids].sort()) {
      const lane = lanes.get(id) ?? "unknown";
      split.lanes[lane] ??= emptyGroup();
      for (let run = 1; run <= runs; run += 1) {
        const result = results.get(rowKey(id, run));
        const label = byId.get(id) as TriageLabel;
        addRow(split.all, label, result);
        addRow(split.lanes[lane], label, result);
      }
    }
    return split;
  };
  return {
    foremanCommit: input.results[0]?.foremanCommit ?? null,
    runId,
    runs,
    splits: {
      heldout: score(input.split.heldout, input.heldoutLabels),
      train: score(input.split.train, input.trainLabels),
    },
  };
}

const pct = ({ correct, total }: Tally) =>
  total
    ? `${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`
    : "n/a";

function groupLines(name: string, group: GroupScore): string[] {
  const { completion, evidenceMisses, fields } = group;
  return [
    `| ${name} | ${group.rows} | ${FIELDS.map((field) => pct(fields[field])).join(" | ")} |`,
    `| | completion: ${COMPLETION.map((key) => `${key} ${completion[key]}`).join(", ")}; evidence misses ${evidenceMisses.rows} rows / ${evidenceMisses.reads} reads; insufficient ${group.insufficient} (excluded) |${" |".repeat(FIELDS.length)}`,
  ];
}

export function renderScorecard(report: ScoreReport): string {
  const header = `| lane | rows | ${FIELDS.join(" | ")} |`;
  const rule = `|${" --- |".repeat(FIELDS.length + 2)}`;
  const sections = (["train", "heldout"] as const).flatMap((name) => {
    const split = report.splits[name];
    return [
      `## ${name === "train" ? "Train" : "Held-out"}`,
      "",
      header,
      rule,
      ...groupLines("all lanes", split.all),
      ...Object.keys(split.lanes)
        .sort()
        .flatMap((lane) => groupLines(lane, split.lanes[lane])),
      "",
    ];
  });
  return [
    "# Triage replay scorecard",
    "",
    `Run ${report.runId ?? "none"}, ${report.runs} run(s) per case, Foreman commit ${report.foremanCommit ?? "none"}.`,
    "",
    ...sections,
    "Every case counts once per run. A missing, failed or cancelled row scores wrong on every field. Text fields match trimmed and case-folded, and a field the label leaves null is unscored. Duplicates match as sets of issue ids, where null means not a duplicate. Master compares the label's master with the parent the run set; a master filed after the case means the run should have created a new one.",
    "",
  ].join("\n");
}
