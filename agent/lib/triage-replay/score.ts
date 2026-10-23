import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeakageHit } from "./leakage.js";
import {
  NEW_MASTER,
  type TriageCase,
  type TriageLabel,
  type TriageResult,
} from "./schema.js";

/**
 * The trusted scorer's pure core (ENG-16049): every cohort case in a split is
 * scored, and anything short of a completed run scores wrong on every field.
 * A case with a seeded phrase in any tool output is leak-suspect: scored apart,
 * with bounds that count it as all failures and as all passes. It reads nothing from disk; `scripts/triage-score.ts` loads the
 * files, including held-out labels from an explicit path, and passes them in.
 */

/** `split.json`: case ids per side, plus the incident groups the split was drawn from. */
export const splitSchema = z.strictObject({
  groups: z.record(z.string(), z.unknown()),
  heldout: z.array(z.string()),
  rule: z.string().optional(),
  train: z.array(z.string()),
});
export type Split = z.infer<typeof splitSchema>;

/** The root-cause judge's grades. */
export const ROOT_CAUSE_GRADES = ["match", "partial", "wrong"] as const;
export type RootCauseGrade = (typeof ROOT_CAUSE_GRADES)[number];

/**
 * The cohort hash: SHA-256 over one line per cohort file (`cases/<file>` and
 * `frozen/<file>`), sorted by name, each `<name>\n<sha256 hex of the file
 * bytes>\n`. `sha256sum`-style, so the Python cohort builder computes the same
 * value.
 */
export function cohortSha256(
  files: readonly { content: string | Buffer; name: string }[]
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.name < b.name ? -1 : Number(a.name > b.name)
  )) {
    const digest = createHash("sha256").update(file.content).digest("hex");
    hash.update(`${file.name}\n${digest}\n`);
  }
  return hash.digest("hex");
}

/** One row of the expected grid: a case and run number. */
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

/** How a row ended; `missing` means the case and run have no result at all. */
export const COMPLETION = [
  "completed",
  "failed",
  "cancelled",
  "boundary_error",
  "missing",
] as const;
type Completion = (typeof COMPLETION)[number];

/** Rows correct out of rows scored for one field. */
export interface Tally {
  correct: number;
  total: number;
}

/** Judge grades over rows whose label has a root cause; failed and leaked rows are wrong. */
export interface RootCauseTally {
  match: number;
  partial: number;
  total: number;
  wrong: number;
}

/** Scores for one split or one lane within it. */
export interface GroupScore {
  completion: Record<Completion, number>;
  evidenceMisses: { reads: number; rows: number };
  fields: Record<Field, Tally>;
  /** Labelled `insufficient`: counted here, excluded from every field score. */
  insufficient: number;
  leaked: number;
  listMembershipUnknown: number;
  /** null when the judge was not run. */
  rootCause: RootCauseTally | null;
  rows: number;
}

export const APART = [
  "edited_after_create",
  "list_membership_unknown",
  "needs_production_data",
  "leak_suspect",
] as const;
export type Apart = (typeof APART)[number];

const APART_TITLES: Record<Apart, string> = {
  edited_after_create: "description edited after filing",
  leak_suspect: "a seeded phrase in a tool output (leak-suspect)",
  list_membership_unknown: "frozen list entry with no creation time",
  needs_production_data: "needs production data",
};

export function apartReason(
  triageCase: TriageCase | undefined,
  listMembershipUnknown = false,
  leakSuspect = false
): Apart | null {
  if (!triageCase) {
    return null;
  }
  if (triageCase.flags.descriptionEditedAfterCreate) {
    return "edited_after_create";
  }
  if (listMembershipUnknown) {
    return "list_membership_unknown";
  }
  if (triageCase.flags.needsProductionData) {
    return "needs_production_data";
  }
  return leakSuspect ? "leak_suspect" : null;
}

export const SUSPECT_EXIT_CODE = 3;

export const scorerExitCode = (
  report: Pick<ScoreReport, "suspects">,
  allowSuspects: boolean
) =>
  report.suspects.cases.length > 0 && !allowSuspects ? SUSPECT_EXIT_CODE : 0;

/** One split's scores, overall and per intake lane, with the cases scored apart from both. */
export interface SplitScore {
  all: GroupScore;
  apart: Record<Apart, GroupScore>;
  /** The main rows plus the leak-suspect cases, counted as all failures or all passes. */
  bounds: {
    asFailures: Record<Field, Tally>;
    asPasses: Record<Field, Tally>;
  };
  lanes: Record<string, GroupScore>;
}

/** The whole scorer output, written as `scores.json`. */
export interface ScoreReport {
  cohortSha256: string;
  foreman: {
    commit: string | null;
    estimatedUsd: number;
    firstStartedAt: string | null;
    lastStartedAt: string | null;
  };
  leakage: { caseId: string; hits: LeakageHit[]; run: number }[];
  runId: string | null;
  runs: number;
  /** Whether `runs` was passed in, or inferred from the highest run number seen. */
  runsGiven: boolean;
  splits: Record<"heldout" | "train", SplitScore>;
  /** Cases with a seeded phrase in any run's tool outputs, and how many rows those are. */
  suspects: { cases: string[]; rows: number };
}

/** Everything the scorer needs, loaded by the CLI. */
export interface ScoreInput {
  cases: readonly TriageCase[];
  cohortSha256: string;
  heldoutLabels: readonly TriageLabel[];
  /** Leakage hits per row key; a case with any hit in any run is leak-suspect and scored apart. */
  leakage?: ReadonlyMap<string, LeakageHit[]>;
  results: readonly TriageResult[];
  /** Judge grades per row key; omit to report root cause as not judged. */
  rootCauseGrades?: ReadonlyMap<string, RootCauseGrade>;
  /** Runs per case, at least 1 and no lower than a run in the results; defaults to the highest run number in the results. */
  runs?: number;
  split: Split;
  trainLabels: readonly TriageLabel[];
}

const WHITESPACE = /\s+/g;
const LEADING_AT = /^@/;
const ID_SEPARATOR = /[\s,]+/;

/** Trimmed, case-folded, whitespace-collapsed; a leading `@` is dropped. null stays null. */
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

/**
 * Duplicate as a set match. The label's list and the final `duplicateOf`
 * (split on commas or spaces) are compared as sets of issue ids; null and
 * empty are the same empty set, so both null matches.
 */
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

/**
 * Field-by-field exact match of one final decision against its label. Text
 * fields compare trimmed and case-folded. A null on the label is a field the
 * human outcome didn't settle, so it is unscored (null here), except the
 * duplicate, where null is the scored answer "not a duplicate". Owner: the
 * label's owner against the assignee the store applied, by the same rule.
 */
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

const emptyGroup = (judged: boolean): GroupScore => ({
  completion: {
    boundary_error: 0,
    cancelled: 0,
    completed: 0,
    failed: 0,
    missing: 0,
  },
  evidenceMisses: { reads: 0, rows: 0 },
  fields: Object.fromEntries(
    FIELDS.map((field) => [field, { correct: 0, total: 0 }])
  ) as Record<Field, Tally>,
  insufficient: 0,
  leaked: 0,
  listMembershipUnknown: 0,
  rootCause: judged ? { match: 0, partial: 0, total: 0, wrong: 0 } : null,
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

/**
 * Everything `scoreReplay` refuses on, callable before any leakage fetch or
 * judge spend: another cohort hash on any result, a split that disagrees with
 * the cohort, results outside the cohort, mixed run ids or Foreman commits, a repeated case and
 * run, a run count under 1 or under a run the results hold, a label filed under
 * the wrong split, or a split case with no label.
 * Returns the results' run id.
 */
export function checkScoreInput(
  input: Omit<ScoreInput, "leakage" | "rootCauseGrades">
): string | null {
  const caseIds = new Set(input.cases.map(({ id }) => id));
  const mismatched = input.results.filter(
    (result) => result.cohortSha256 !== input.cohortSha256
  );
  if (mismatched.length) {
    fail(
      `Refusing to score: results were run against a different cohort than ${input.cohortSha256}`,
      mismatched.map(({ caseId, run }) => rowKey(caseId, run))
    );
  }
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
  result: TriageResult | undefined,
  leaked: boolean,
  grade: RootCauseGrade | undefined
) {
  group.rows += 1;
  group.completion[result?.status ?? "missing"] += 1;
  if (result?.evidenceMisses.length) {
    group.evidenceMisses.rows += 1;
    group.evidenceMisses.reads += result.evidenceMisses.length;
  }
  if (leaked) {
    group.leaked += 1;
  }
  if (result?.listMembershipUnknown.length) {
    group.listMembershipUnknown += 1;
  }
  if (label.insufficient) {
    group.insufficient += 1;
    return;
  }
  const scorable =
    result?.status === "completed" && !leaked ? result.final : null;
  const matches = scorable ? fieldMatches(label, scorable) : null;
  for (const field of scoredFields(label)) {
    group.fields[field].total += 1;
    group.fields[field].correct += matches?.[field] ? 1 : 0;
  }
  if (group.rootCause && label.rootCause) {
    group.rootCause.total += 1;
    group.rootCause[scorable ? (grade ?? "wrong") : "wrong"] += 1;
  }
}

/**
 * Score a replay against the frozen cohort. Refuses when any result was run
 * against another cohort hash, when results, split and labels disagree, or
 * when a split case has no label. Every case times every run is a row: no
 * result counts as `missing`, and a missing, failed, cancelled, boundary
 * error row scores wrong on every field.
 */
export function scoreReplay(input: ScoreInput): ScoreReport {
  const runId = checkScoreInput(input);
  const runs =
    input.runs ?? Math.max(1, ...input.results.map(({ run }) => run));
  const results = new Map(
    input.results.map((result) => [rowKey(result.caseId, result.run), result])
  );
  const cases = new Map(input.cases.map((item) => [item.id, item]));
  const judged = input.rootCauseGrades !== undefined;
  const heldout = new Set(input.split.heldout);
  const suspectCases = new Set(
    [...(input.leakage ?? new Map<string, LeakageHit[]>())]
      .filter(([, hits]) => hits.length > 0)
      .map(([key]) => key.split("#")[0])
  );
  const membershipUnknown = new Set(
    input.results
      .filter((result) => result.listMembershipUnknown.length > 0)
      .map((result) => result.caseId)
  );
  const score = (ids: readonly string[], labels: readonly TriageLabel[]) => {
    const byId = labelsFor(ids, labels);
    const split: SplitScore = {
      all: emptyGroup(judged),
      apart: Object.fromEntries(
        APART.map((reason) => [reason, emptyGroup(judged)])
      ) as Record<Apart, GroupScore>,
      bounds: {
        asFailures: {} as Record<Field, Tally>,
        asPasses: {} as Record<Field, Tally>,
      },
      lanes: {},
    };
    for (const id of [...ids].sort()) {
      const triageCase = cases.get(id);
      const lane = triageCase?.lane ?? "unknown";
      const label = byId.get(id) as TriageLabel;
      const reason = apartReason(
        triageCase,
        membershipUnknown.has(id),
        suspectCases.has(id)
      );
      if (!(reason || split.lanes[lane])) {
        split.lanes[lane] = emptyGroup(judged);
      }
      const groups = reason
        ? [split.apart[reason]]
        : [split.all, split.lanes[lane]];
      for (let run = 1; run <= runs; run += 1) {
        const key = rowKey(id, run);
        const leaked = Boolean(input.leakage?.get(key)?.length);
        const grade = input.rootCauseGrades?.get(key);
        for (const group of groups) {
          addRow(group, label, results.get(key), leaked, grade);
        }
      }
    }
    for (const field of FIELDS) {
      const main = split.all.fields[field];
      const suspect = split.apart.leak_suspect.fields[field];
      split.bounds.asFailures[field] = {
        correct: main.correct,
        total: main.total + suspect.total,
      };
      split.bounds.asPasses[field] = {
        correct: main.correct + suspect.total,
        total: main.total + suspect.total,
      };
    }
    return split;
  };
  const starts = input.results.map(({ startedAt }) => startedAt).sort();
  return {
    cohortSha256: input.cohortSha256,
    foreman: {
      commit: input.results[0]?.foremanCommit ?? null,
      estimatedUsd: input.results.reduce(
        (total, { estimatedUsd }) => total + estimatedUsd,
        0
      ),
      firstStartedAt: starts[0] ?? null,
      lastStartedAt: starts.at(-1) ?? null,
    },
    leakage: [...(input.leakage ?? new Map<string, LeakageHit[]>())]
      .filter(([, hits]) => hits.length)
      .map(([key, hits]) => {
        const [caseId, run] = key.split("#");
        // A held-out hit keeps its kind and source only, so no label text reaches the outputs.
        const sealed = heldout.has(caseId);
        return {
          caseId,
          hits: hits.map((hit) => (sealed ? { ...hit, match: "" } : hit)),
          run: Number(run),
        };
      }),
    runId,
    runs,
    runsGiven: input.runs !== undefined,
    splits: {
      heldout: score(input.split.heldout, input.heldoutLabels),
      train: score(input.split.train, input.trainLabels),
    },
    suspects: {
      cases: [...suspectCases].sort(),
      rows: [...(input.leakage ?? new Map<string, LeakageHit[]>())].filter(
        ([, hits]) => hits.length > 0
      ).length,
    },
  };
}

/**
 * Rows the judge must grade: completed, leak-free, sufficient labels with a
 * root cause and a saved document. Every other row is wrong without a call.
 */
export function judgeableRows(
  results: readonly TriageResult[],
  labels: ReadonlyMap<string, TriageLabel>,
  leakage: ReadonlyMap<string, LeakageHit[]>
): TriageResult[] {
  return results.filter((result) => {
    const label = labels.get(result.caseId);
    return (
      result.status === "completed" &&
      result.final !== null &&
      result.document !== null &&
      !leakage.get(rowKey(result.caseId, result.run))?.length &&
      label !== undefined &&
      !label.insufficient &&
      label.rootCause !== null
    );
  });
}

const pct = ({ correct, total }: Tally) =>
  total
    ? `${((correct / total) * 100).toFixed(1)}% (${correct}/${total})`
    : "n/a";

function groupLines(name: string, group: GroupScore): string[] {
  const { completion, evidenceMisses, fields, rootCause } = group;
  const rc = rootCause
    ? `${pct({ correct: rootCause.match, total: rootCause.total })}, partial ${rootCause.partial}, wrong ${rootCause.wrong}`
    : "not judged";
  return [
    `| ${name} | ${group.rows} | ${FIELDS.map((field) => pct(fields[field])).join(" | ")} | ${rc} |`,
    `| | completion: ${COMPLETION.map((key) => `${key} ${completion[key]}`).join(", ")}, leaked ${group.leaked}; evidence misses ${evidenceMisses.rows} rows / ${evidenceMisses.reads} reads; insufficient ${group.insufficient} (excluded); frozen list membership at case time unknown in ${group.listMembershipUnknown} rows |${" |".repeat(FIELDS.length + 1)}`,
  ];
}

/** The scorecard as Markdown: train and held-out apart, each split by intake lane. */
export function renderScorecard(report: ScoreReport): string {
  const header = `| lane | rows | ${FIELDS.join(" | ")} | root cause |`;
  const rule = `|${" --- |".repeat(FIELDS.length + 3)}`;
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
      "Scored apart, never in the rows above:",
      "",
      header,
      rule,
      ...APART.flatMap((reason) =>
        groupLines(APART_TITLES[reason], split.apart[reason])
      ),
      "",
    ];
  });
  const leaks = report.leakage.length
    ? report.leakage.map(
        ({ caseId, hits, run }) =>
          `- ${rowKey(caseId, run)}: ${hits.map((hit) => `${hit.kind} in ${hit.source}`).join("; ")}`
      )
    : ["- none"];
  const bounds = (["train", "heldout"] as const).flatMap((name) =>
    (["asFailures", "asPasses"] as const).map(
      (bound) =>
        `| ${name} | suspects as ${bound === "asFailures" ? "failures" : "passes"} | ${FIELDS.map((field) => pct(report.splits[name].bounds[bound][field])).join(" | ")} |`
    )
  );
  return [
    "# Triage replay scorecard",
    "",
    `Cohort ${report.cohortSha256}, run ${report.runId ?? "none"}, ${report.runs} run(s) per case (${report.runsGiven ? "given" : "inferred from the results; pass --runs so a run missing for every case still counts"}).`,
    "",
    `Foreman commit ${report.foreman.commit ?? "none"}, replays started ${report.foreman.firstStartedAt ?? "never"} to ${report.foreman.lastStartedAt ?? "never"}, estimated $${report.foreman.estimatedUsd.toFixed(2)} charged to the replays (an estimate, not metered).`,
    "",
    ...sections,
    `## Leak-suspect cases: ${report.suspects.cases.length}`,
    "",
    `${report.suspects.cases.length} case(s), ${report.suspects.rows} row(s), had a seeded phrase in a tool output and are left out of the main rows above. The check cannot tell the pinned code, skill reference files or the run's own scratch from planted text, so it errs toward suspect and the main score is biased down. The two scores below bracket it: every suspect case counted as a failure, then as a pass.`,
    "",
    `| split | suspects | ${FIELDS.join(" | ")} |`,
    `|${" --- |".repeat(FIELDS.length + 2)}`,
    ...bounds,
    "",
    ...leaks,
    "",
    "Every cohort case counts once per run, in the main rows or in exactly one scored-apart group, taken in this order: a description edited after filing, a case whose run answered from a frozen list entry with no creation time (so its case-time membership is unknown; any run of the case puts every run of it here), a case that needs production data the replay can't reach, or a leak-suspect case (any run of it puts every run of it here). A missing, failed, cancelled or boundary-error row scores wrong on every field. Text fields match trimmed and case-folded; a field the label leaves null is unscored, so its total counts only labels that settle it. Owner compares the label owner with the assignee the store applied. Duplicates match as sets of issue ids, with null and empty equal (a null duplicate is scored: it means not a duplicate); the final `duplicateOf` is split on commas or spaces. Master compares the label's master with the parent the run set, and a master filed after the case means the run should have created a new one.",
    "",
  ].join("\n");
}
