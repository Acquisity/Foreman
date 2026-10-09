// Claims judge review and calibration (ENG-14686).
//
//   pnpm widget:judge review [dir]  regenerate a run's review.md from its records
//   pnpm widget:judge gold [dir]    turn the marks in review.md into evals/widget/judge-gold.json
//   pnpm widget:judge rerun         judge every gold answer twice; agreement and flip rate per claim
//   pnpm widget:judge scorecard [eval dir...]
//                                   investigate scorecard (ENG-15024) over one or more replay runs
//
// [dir] defaults to the newest run under .eve/widget-judge/; [eval dir] to the
// newest `eve eval` run under .eve/evals/. rerun calls the
// judge model through the gateway, so it needs AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { widgetCaseSchema } from "../agent/lib/widget-case.js";
import {
  claimsFor,
  JUDGE_MODEL,
  JUDGE_OUTPUT,
  type JudgeRecord,
  judgeAnswer,
  judgeRecordSchema,
  parseMarks,
  type ReplayRow,
  readRecords,
  renderReview,
  renderScorecard,
  reviewedSample,
  type ScoredReplay,
  scorecard,
} from "../agent/lib/widget-judge.js";

import {
  calibrated,
  type GoldEntry,
  goldSchema,
  mergeGold,
  scoreAgainstGold,
  toGold,
  writeGold,
} from "../agent/lib/widget-judge-calibration.js";

const GOLD = "evals/widget/judge-gold.json";

const latestRun = () => {
  const runs = existsSync(JUDGE_OUTPUT) ? readdirSync(JUDGE_OUTPUT).sort() : [];
  if (!runs.length) {
    throw new Error(`No judge runs under ${JUDGE_OUTPUT}.`);
  }
  return `${JUDGE_OUTPUT}/${runs.at(-1)}`;
};

const readGold = (): GoldEntry[] =>
  goldSchema.parse(
    existsSync(GOLD) ? JSON.parse(readFileSync(GOLD, "utf8")) : []
  );

async function judgeGold(gold: GoldEntry[]) {
  const run = new Map<string, JudgeRecord>();
  for (const { sample } of gold) {
    // Keep the reviewed question/evidence fixed, but use today's authored claims.
    const { expectations } = widgetCaseSchema.parse(
      JSON.parse(readFileSync(`evals/widget/cases/${sample.case}.json`, "utf8"))
    );
    const recorded = { ...sample.recorded, expectations };
    const claims = claimsFor(recorded);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one judge call at a time keeps the run cheap to stop.
      const { gaps, verdicts } = await judgeAnswer(
        recorded,
        sample.answer,
        claims
      );
      run.set(
        sample.case,
        reviewedSample(sample.case, recorded, sample.answer, verdicts, gaps)
      );
    } catch (error) {
      // The case stays out of the run, so its coverage counts as missing and the rerun fails.
      console.error(`judge failed on ${sample.case}: ${String(error)}`);
    }
  }
  return run;
}

const EVALS = ".eve/evals";
const ROW = "row: ";
const REVIEW = "judge review: ";
const RESULT_FILE = /^\d+\.json$/;
const REVIEW_PAGE = /\/review\.md$/;
const CASE_FILE = /\.json$/;

/** Every investigate case one `eve eval` run replayed: its row, its case file and its judge record. */
function replaysIn(dir: string): ScoredReplay[] {
  const replay = `${dir}/evals/widget/replay`;
  if (!existsSync(replay)) {
    throw new Error(`${replay} has no widget replay results.`);
  }
  return readdirSync(replay)
    .filter((file) => RESULT_FILE.test(file))
    .flatMap((file) => {
      const logs: string[] =
        JSON.parse(readFileSync(`${replay}/${file}`, "utf8")).result?.logs ??
        [];
      const line = logs.find((log) => log.startsWith(ROW));
      if (!line) {
        return [];
      }
      const row = JSON.parse(line.slice(ROW.length)) as ReplayRow & {
        case: string;
      };
      // A case moved to cases-pending since the run no longer counts.
      if (!existsSync(row.case)) {
        return [];
      }
      const recorded = widgetCaseSchema.parse(
        JSON.parse(readFileSync(row.case, "utf8"))
      );
      if (recorded.mode !== "investigate") {
        return [];
      }
      const review = logs
        .find((log) => log.startsWith(REVIEW))
        ?.slice(REVIEW.length)
        .replace(REVIEW_PAGE, "");
      const name = row.case.split("/").at(-1)?.replace(CASE_FILE, "");
      const path = `${review}/records/${name}.json`;
      return [
        {
          record:
            review && existsSync(path)
              ? judgeRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
              : null,
          recorded,
          row,
        },
      ];
    });
}

const percent = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";

async function main() {
  const [command, dir = command === "rerun" ? "" : latestRun()] =
    process.argv.slice(2);
  if (command === "scorecard") {
    const runs = process.argv.slice(3);
    const dirs = runs.length
      ? runs
      : [`${EVALS}/${readdirSync(EVALS).sort().at(-1)}`];
    console.log(renderScorecard(scorecard(dirs.flatMap(replaysIn))));
    return;
  }
  if (command === "review") {
    writeFileSync(`${dir}/review.md`, renderReview(readRecords(dir)));
    console.log(`${dir}/review.md`);
    return;
  }
  if (command === "gold") {
    const records = readRecords(dir);
    const marks = parseMarks(readFileSync(`${dir}/review.md`, "utf8"));
    const next = toGold(records, marks);
    const rows = records.reduce(
      (sum, record) => sum + record.verdicts.length,
      0
    );
    writeGold(GOLD, mergeGold(readGold(), next));
    console.log(
      `${GOLD}: ${marks.size} of ${rows} rows marked, ${next.length} case(s) written.`
    );
    return;
  }
  if (command === "rerun") {
    const gold = readGold();
    if (!gold.some((entry) => entry.labels.length)) {
      throw new Error(`${GOLD} has no labels yet.`);
    }
    const scores = scoreAgainstGold(
      gold,
      await judgeGold(gold),
      await judgeGold(gold)
    );
    let under = scores.size === 0;
    console.log(`judge ${JUDGE_MODEL}, two runs against ${GOLD}`);
    for (const [id, score] of scores) {
      const { agree, total } = score.agreement;
      const { flipped, total: pairs } = score.flips;
      const low = !calibrated(score);
      under ||= low;
      console.log(
        `${low ? "UNDER" : "ok   "} ${id}: agreement ${percent(agree, total)} (${agree}/${total}), flips ${percent(flipped, pairs)} (${flipped}/${pairs}), coverage ${score.coverage.measured}/${score.coverage.required} (stale ${score.coverage.stale}, missing ${score.coverage.missing}, unlabelled ${score.coverage.unlabelled})`
      );
    }
    process.exitCode = under ? 1 : 0;
    return;
  }
  throw new Error(
    "Usage: pnpm widget:judge review|gold [dir] | rerun | scorecard [eval dir...]"
  );
}

await main();
