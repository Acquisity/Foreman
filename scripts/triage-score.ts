// Trusted triage replay scorer (ENG-16049).
//
//   pnpm triage:score <resultsDir> --heldout-labels <path> [--judge] [--max-judge-calls N]
//                     [--calibration <path>] [--rerun]
//                     [--cohort evals/triage] [--repo Acquisity/Acquisity] [--runs N]
//
// Scores every result JSON in <resultsDir> against the frozen cohort, train
// labels from the repository and held-out labels from the explicit path, which
// must sit outside this repository. The leakage check fetches each fix PR with
// `gh pr view` and refuses the run when it can't. --judge grades root cause
// through headless Claude Code, capped at --max-judge-calls (default 20), and
// refuses before the first call when more rows need judging than the cap.
// --calibration reads hand labels (row, documentSha256, grade, reason) from a
// file outside this repository and reports the judge's agreement with them;
// --rerun judges every row twice and reports the flip rate, so it needs twice
// the calls. Both print in the scorecard as counts, never label text.
// Writes scorecard.md and scores.json into <resultsDir>; exits 1 on any leak.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  calibrate,
  handLabelsSchema,
  renderCalibration,
} from "../agent/lib/triage-replay/calibration.js";
import {
  outsideRepositoryPath,
  readCohortFiles,
} from "../agent/lib/triage-replay/cohort-files.js";
import {
  JUDGE_MODEL,
  rootCauseJudge,
} from "../agent/lib/triage-replay/judge.js";
import {
  findLeaks,
  type LeakageHit,
  leaksThatCount,
} from "../agent/lib/triage-replay/leakage.js";
import {
  type TriageLabel,
  type TriageResult,
  triageCaseSchema,
  triageLabelSchema,
  triageResultSchema,
} from "../agent/lib/triage-replay/schema.js";
import {
  checkScoreInput,
  cohortSha256,
  judgeableRows,
  type RootCauseGrade,
  renderScorecard,
  rowKey,
  scoreReplay,
  splitSchema,
} from "../agent/lib/triage-replay/score.js";

const run = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const JSON_FILE = /\.json$/;
const OUTPUTS = new Set(["scores.json"]);
const labelsSchema = z.array(triageLabelSchema);

const USAGE =
  "Usage: pnpm triage:score <resultsDir> --heldout-labels <path> [--judge] [--max-judge-calls N] [--calibration <path>] [--rerun] [--cohort evals/triage] [--repo Acquisity/Acquisity] [--runs N]";

interface Options {
  calibration: string;
  cohort: string;
  heldout: string;
  judge: boolean;
  maxJudgeCalls: number;
  repo: string;
  rerun: boolean;
  results: string;
  runs: number | undefined;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    calibration: "",
    cohort: "evals/triage",
    heldout: "",
    judge: false,
    maxJudgeCalls: 20,
    repo: "Acquisity/Acquisity",
    rerun: false,
    results: "",
    runs: undefined,
  };
  const rest = [...argv];
  const value = (flag: string) => {
    const next = rest.shift();
    if (!next || next.startsWith("--")) {
      throw new Error(`${flag} needs a value.\n${USAGE}`);
    }
    return next;
  };
  const count = (flag: string, least = 0) => {
    const parsed = Number(value(flag));
    if (!Number.isInteger(parsed) || parsed < least) {
      throw new Error(`${flag} needs a whole number of at least ${least}.`);
    }
    return parsed;
  };
  const flags: Record<string, (flag: string) => void> = {
    "--calibration": (flag) => {
      options.calibration = value(flag);
    },
    "--cohort": (flag) => {
      options.cohort = value(flag);
    },
    "--heldout-labels": (flag) => {
      options.heldout = value(flag);
    },
    "--judge": () => {
      options.judge = true;
    },
    "--max-judge-calls": (flag) => {
      options.maxJudgeCalls = count(flag);
    },
    "--repo": (flag) => {
      options.repo = value(flag);
    },
    "--rerun": () => {
      options.rerun = true;
    },
    "--runs": (flag) => {
      options.runs = count(flag, 1);
    },
  };
  while (rest.length) {
    const arg = rest.shift() as string;
    const flag = flags[arg];
    if (flag) {
      flag(arg);
    } else if (arg.startsWith("--") || options.results) {
      throw new Error(`Unexpected argument ${arg}.\n${USAGE}`);
    } else {
      options.results = arg;
    }
  }
  if (!(options.results && options.heldout)) {
    throw new Error(USAGE);
  }
  if ((options.calibration || options.rerun) && !options.judge) {
    throw new Error(`--calibration and --rerun need --judge.\n${USAGE}`);
  }
  return options;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function parseFile<T>(schema: z.ZodType<T>, path: string): T {
  const parsed = schema.safeParse(readJson(path));
  if (!parsed.success) {
    throw new Error(`${path} is not valid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function loadCohort(dir: string) {
  const files = readCohortFiles(dir);
  const sha = cohortSha256(files);
  const { builtAt, sha256: frozen } = parseFile(
    z.object({ builtAt: z.iso.datetime(), sha256: z.string() }),
    join(dir, "cohort.json")
  );
  if (frozen !== sha) {
    throw new Error(
      `Refusing to score: cohort files hash to ${sha}, but cohort.json froze ${frozen}.`
    );
  }
  return {
    builtAt,
    cases: files
      .filter(({ name }) => name.startsWith("cases/"))
      .map(({ name }) => parseFile(triageCaseSchema, join(dir, name))),
    sha,
    split: parseFile(splitSchema, join(dir, "split.json")),
    trainLabels: parseFile(labelsSchema, join(dir, "labels", "train.json")),
  };
}

function outsideRepository<T>(
  schema: z.ZodType<T>,
  path: string,
  what: string
) {
  return parseFile(schema, outsideRepositoryPath(path, what));
}

const loadHeldoutLabels = (path: string) =>
  outsideRepository(labelsSchema, path, "Held-out labels");

const loadResults = (dir: string) =>
  readdirSync(dir)
    .filter((name) => JSON_FILE.test(name) && !OUTPUTS.has(name))
    .sort()
    .map((name) => parseFile(triageResultSchema, join(dir, name)));

const prSchema = z.object({
  body: z.string(),
  mergedAt: z.string().nullable().optional(),
  title: z.string(),
});

async function fetchPr(repo: string, pr: number) {
  try {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "view",
        String(pr),
        "--repo",
        repo,
        "--json",
        "title,body,mergedAt",
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: GH_TIMEOUT_MS }
    );
    return prSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new Error(
      `Refusing to score: gh pr view ${repo}#${pr} failed, so leakage can't be checked. ${String(error).slice(0, 300)}`,
      { cause: error }
    );
  }
}

async function judgeRows(
  judge: ReturnType<typeof rootCauseJudge>,
  rows: readonly TriageResult[],
  labels: ReadonlyMap<string, TriageLabel>
): Promise<Map<string, RootCauseGrade>> {
  const settled = await Promise.allSettled(
    rows.map(async (result) => ({
      key: rowKey(result.caseId, result.run),
      verdict: await judge.judge(
        labels.get(result.caseId) as TriageLabel,
        result
      ),
    }))
  );
  const failed = settled.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [
          `${rowKey(rows[index].caseId, rows[index].run)}: ${String(outcome.reason)}`,
        ]
      : []
  );
  if (failed.length) {
    throw new Error(`Root-cause judge failed:\n${failed.join("\n")}`);
  }
  return new Map(
    settled.flatMap((outcome) =>
      outcome.status === "fulfilled"
        ? [[outcome.value.key, outcome.value.verdict.grade] as const]
        : []
    )
  );
}

async function judgeAndCalibrate(
  options: Options,
  results: readonly TriageResult[],
  labels: ReadonlyMap<string, TriageLabel>,
  leakage: ReadonlyMap<string, LeakageHit[]>
) {
  const handLabels = options.calibration
    ? outsideRepository(handLabelsSchema, options.calibration, "Hand labels")
    : null;
  const rows = judgeableRows(results, labels, leakage);
  const passes = options.rerun ? 2 : 1;
  if (rows.length * passes > options.maxJudgeCalls) {
    throw new Error(
      `Refusing to judge: ${rows.length} rows times ${passes} pass(es) need the judge but --max-judge-calls is ${options.maxJudgeCalls}.`
    );
  }
  console.error(
    `Judging ${rows.length} root causes ${passes} time(s) with ${JUDGE_MODEL}.`
  );
  const judge = rootCauseJudge(options.maxJudgeCalls);
  const rootCauseGrades = await judgeRows(judge, rows, labels);
  const second = options.rerun
    ? await judgeRows(judge, rows, labels)
    : undefined;
  const calibration =
    handLabels || second
      ? calibrate(
          handLabels ?? [],
          new Map(
            results.map((result) => [rowKey(result.caseId, result.run), result])
          ),
          rootCauseGrades,
          second
        )
      : undefined;
  return { calibration, rootCauseGrades };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cohort = loadCohort(options.cohort);
  const heldoutLabels = loadHeldoutLabels(options.heldout);
  const results = loadResults(options.results);
  const input = {
    cases: cohort.cases,
    cohortBuiltAt: cohort.builtAt,
    cohortSha256: cohort.sha,
    heldoutLabels,
    results,
    runs: options.runs,
    split: cohort.split,
    trainLabels: cohort.trainLabels,
  };
  checkScoreInput(input);

  const labels = new Map<string, TriageLabel>(
    [...cohort.trainLabels, ...heldoutLabels].map((label) => [label.id, label])
  );
  const cases = new Map(cohort.cases.map((item) => [item.id, item]));
  const prs = new Map<number, Awaited<ReturnType<typeof fetchPr>>>();
  const leakage = new Map<string, LeakageHit[]>();
  for (const result of results) {
    const label = labels.get(result.caseId) as TriageLabel;
    const ticket = cases.get(result.caseId)?.ticket;
    if (label.fixPr && !prs.has(label.fixPr)) {
      // biome-ignore lint/performance/noAwaitInLoops: one gh call at a time, cached per PR.
      prs.set(label.fixPr, await fetchPr(options.repo, label.fixPr));
    }
    const { counted, availableAtTriage } = leaksThatCount(
      findLeaks({
        baseline: ticket ? `${ticket.title}\n${ticket.description}` : "",
        label,
        pr: label.fixPr ? prs.get(label.fixPr) : undefined,
        result,
      }),
      cases.get(result.caseId),
      label.fixPr ? prs.get(label.fixPr) : undefined
    );
    if (availableAtTriage.length > 0) {
      console.error(
        `${rowKey(result.caseId, result.run)}: ${availableAtTriage.length} fix reference(s) seen; the fix merged before triage, so not a leak.`
      );
    }
    leakage.set(rowKey(result.caseId, result.run), counted);
  }

  const { calibration, rootCauseGrades } = options.judge
    ? await judgeAndCalibrate(options, results, labels, leakage)
    : { calibration: undefined, rootCauseGrades: undefined };

  const report = scoreReplay({
    ...input,
    leakage,
    rootCauseGrades,
  });
  const scorecard = `${renderScorecard(report)}${calibration ? renderCalibration(calibration) : ""}`;
  writeFileSync(join(options.results, "scorecard.md"), scorecard);
  writeFileSync(
    join(options.results, "scores.json"),
    `${JSON.stringify({ ...report, calibration }, null, 2)}\n`
  );
  console.log(scorecard);
  if (report.leakage.length) {
    console.error(
      `Leakage check failed on ${report.leakage.length} row(s); those rows score wrong.`
    );
    process.exitCode = 1;
  }
}

await main();
